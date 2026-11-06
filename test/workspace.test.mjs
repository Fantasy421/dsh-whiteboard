import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BoardStore } from '../src/store.mjs';
import { WorkspaceStore } from '../src/workspace.mjs';

const hash = (id) => createHash('sha256').update(id, 'utf8').digest('hex');
const catalogFile = (directory, sessionId = 's') => path.join(directory, 'catalogs', `${hash(sessionId)}.json`);
const legacyFile = (directory, sessionId = 's') => path.join(directory, `${hash(sessionId)}.json`);
const sceneFile = (directory, sessionId, boardId) => boardId === 'default' ? legacyFile(directory, sessionId)
  : path.join(directory, 'boards', hash(sessionId), boardId, `${hash(sessionId)}.json`);
const scene = (elements = [], selectedIds = [], files = {}) => ({ elements, selectedIds, files });
const shape = (id, extra = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 100, height: 100, ...extra });
const add = (id = 'a', extra = {}) => ({ op: 'add', id, type: 'rectangle', ...extra });
const virtual = (sessionId = 's') => ({ sessionId, revision: 0, activeBoardId: 'default', boards: [{ id: 'default', name: '白板 1' }] });
const diskCatalog = (sessionId = 's') => ({ ...virtual(sessionId), boards: [{ id: 'default', name: '白板 1', deleted: false }] });

async function setup(t) {
  const prefix = path.join(os.tmpdir(), 'dsh-whiteboard-workspace-');
  const directory = await mkdtemp(prefix);
  const store = new WorkspaceStore({ directory });
  const stores = [store];
  t.after(async () => {
    await Promise.all(stores.map((item) => item.dispose()));
    // Cleanup is restricted to this exact test-owned root, never a configured user store.
    assert.equal(path.dirname(path.resolve(directory)), path.dirname(path.resolve(prefix)));
    assert.ok(path.basename(directory).startsWith('dsh-whiteboard-workspace-'));
    await rm(directory, { recursive: true, force: true });
  });
  const reopen = () => { const next = new WorkspaceStore({ directory }); stores.push(next); return next; };
  return { directory, store, reopen };
}

async function writeCatalog(directory, value, sessionId = 's') {
  await mkdir(path.join(directory, 'catalogs'), { recursive: true });
  await writeFile(catalogFile(directory, sessionId), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}

function pauseMethod(target, method) {
  const original = target[method];
  let release, enter;
  const blocked = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  target[method] = async function (...args) { enter(); await blocked; return original.apply(this, args); };
  return { entered, release: () => { target[method] = original; release(); } };
}

test('virtual catalogs and empty scene reads are detached and create no files or directories', async (t) => {
  const { directory, store } = await setup(t);
  const list = await store.list('s');
  assert.deepEqual(list, virtual());
  list.boards[0].name = 'mutated';
  list.boards.push({ id: randomUUID(), name: 'fake' });
  assert.deepEqual(await store.list('s'), virtual());
  const board = await store.get('s');
  assert.equal(board.boardId, 'default');
  assert.equal(board.revision, 0);
  board.elements.push(shape('fake'));
  assert.deepEqual((await store.get('s', 'default')).elements, []);
  assert.deepEqual(await store.list('other'), virtual('other'));
  assert.deepEqual(await readdir(directory), []);
  const nested = new WorkspaceStore({ directory: path.join(directory, 'not-created') });
  t.after(() => nested.dispose());
  await nested.list('s');
  await nested.get('s');
  assert.deepEqual(await readdir(directory), []);
});

test('legacy root scene bytes and contract survive listing, creation and activation without migration', async (t) => {
  const { directory, store, reopen } = await setup(t);
  const legacy = new BoardStore({ directory });
  t.after(() => legacy.dispose());
  const old = await legacy.patch('s', 0, [add('old', { type: 'line', points: [[0, 0], [100, 50]], lineStyle: 'curved' }), add('labelled', { text: 'Legacy label' })]);
  const bytes = await readFile(legacyFile(directory));
  assert.deepEqual(await store.list('s'), virtual());
  assert.deepEqual(await store.get('s'), { ...old, boardId: 'default' });
  assert.deepEqual(await readdir(directory), [path.basename(legacyFile(directory))]);
  const created = await store.manage('s', 0, 'create', { name: '  第二页  ' });
  assert.equal(created.boards[1].name, '第二页');
  assert.equal(created.activeBoardId, created.boards[1].id);
  assert.deepEqual(await readFile(legacyFile(directory)), bytes);
  assert.equal((await legacy.get('s')).revision, old.revision);
  assert.equal((await store.get('s')).revision, 0);
  await store.manage('s', 1, 'activate', { boardId: 'default' });
  assert.deepEqual(await reopen().get('s'), { ...old, boardId: 'default' });
  assert.deepEqual(await readFile(legacyFile(directory)), bytes);
  assert.equal((await stat(catalogFile(directory))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['catalogs', path.basename(legacyFile(directory))].sort());
});

test('legacy-only save and patch write the exact original BoardStore root format and no catalog', async (t) => {
  const { directory, store } = await setup(t);
  const first = await store.save('s', 0, scene([shape('one')], ['one']));
  const second = await store.patch('s', 1, [{ op: 'update', id: 'one', x: 50 }]);
  assert.equal(first.boardId, 'default');
  assert.equal(second.revision, 2);
  const raw = JSON.parse(await readFile(legacyFile(directory), 'utf8'));
  assert.equal(Object.hasOwn(raw, 'boardId'), false);
  assert.equal(raw.sessionId, 's');
  assert.equal(raw.revision, 2);
  assert.deepEqual(await store.list('s'), virtual());
  assert.deepEqual(await readdir(directory), [path.basename(legacyFile(directory))]);
});

test('independent scenes, files, selections and revisions persist without contaminating the catalog', async (t) => {
  const { directory, store, reopen } = await setup(t);
  const catalog = await store.manage('s', 0, 'create', { name: 'Other' });
  const id = catalog.activeBoardId;
  assert.match(id, /^[0-9a-f-]{36}$/u);
  const first = await store.patch('s', 0, [add('root')], 'default');
  const png = { id: 'pixel', mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=', created: 1 };
  const input = scene([shape('image', { type: 'image', fileId: 'pixel', scale: [1, 1] })], ['image'], { pixel: png });
  const second = await store.save('s', 0, input, id);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.equal(second.boardId, id);
  const updated = await store.patch('s', 1, [add('extra')], id);
  assert.equal(updated.revision, 2);
  assert.equal((await store.get('s', 'default')).revision, 1);
  assert.deepEqual(await store.list('s'), catalog);
  const next = reopen();
  assert.deepEqual(await next.get('s', id), updated);
  assert.deepEqual(await next.get('s', 'default'), first);
  assert.equal((await next.get('s')).boardId, id);
  const raw = JSON.parse(await readFile(sceneFile(directory, 's', id), 'utf8'));
  assert.equal(raw.sessionId, 's');
  assert.equal(Object.hasOwn(raw, 'boardId'), false);
  assert.equal((await stat(sceneFile(directory, 's', id))).mode & 0o777, 0o600);
});

test('catalog CRUD has independent CAS, duplicate names, active selection and detached conflict snapshots', async (t) => {
  const { store, directory, reopen } = await setup(t);
  const first = await store.manage('s', 0, 'create', { name: '白板 1' });
  const id = first.activeBoardId;
  assert.equal(first.revision, 1);
  assert.deepEqual(first.boards.map((entry) => entry.name), ['白板 1', '白板 1']);
  await assert.rejects(store.manage('s', 0, 'rename', { boardId: id, name: 'stale' }), (error) => {
    assert.equal(error.code, 'catalog-conflict');
    assert.deepEqual(error.catalog, first);
    error.catalog.boards[0].name = 'mutated conflict';
    return true;
  });
  assert.deepEqual(await store.list('s'), first);
  const renamed = await store.manage('s', 1, 'rename', { boardId: id, name: '  新名字  ' });
  assert.equal(renamed.boards[1].name, '新名字');
  const activated = await store.manage('s', 2, 'activate', { boardId: 'default' });
  assert.equal(activated.activeBoardId, 'default');
  assert.deepEqual(await reopen().list('s'), activated);
  await store.patch('s', 0, [add()], id);
  assert.deepEqual(await store.list('s'), activated);
  const deleted = await store.manage('s', 3, 'delete', { boardId: 'default' });
  assert.equal(deleted.activeBoardId, id);
  assert.deepEqual(deleted.boards, [{ id, name: '新名字' }]);
  assert.equal((await store.patch('s', 1, [add('implicit')])).boardId, id);
  await assert.rejects(store.manage('s', 4, 'delete', { boardId: id }), { code: 'validation' });
  await assert.rejects(store.manage('s', 4, 'activate', { boardId: 'default' }), { code: 'not-found' });
  assert.deepEqual(await store.list('s'), deleted);
  const raw = JSON.parse(await readFile(catalogFile(directory), 'utf8'));
  assert.deepEqual(raw.boards[0], { id: 'default', name: '白板 1', deleted: true });
});

test('deleting an active nondefault selects remaining board and soft deletion retains scene bytes', async (t) => {
  const { directory, store } = await setup(t);
  const created = await store.manage('s', 0, 'create');
  assert.equal(created.boards[1].name, '白板 2');
  const id = created.activeBoardId;
  await store.patch('s', 0, [add()], id);
  const bytes = await readFile(sceneFile(directory, 's', id));
  const deleted = await store.manage('s', 1, 'delete', { boardId: id });
  assert.equal(deleted.activeBoardId, 'default');
  for (const request of [store.get('s', id), store.save('s', 1, scene(), id), store.patch('s', 1, [], id),
    store.manage('s', 2, 'rename', { boardId: id, name: 'resurrect' }), store.manage('s', 2, 'delete', { boardId: id })]) {
    await assert.rejects(request, { code: 'not-found' });
  }
  assert.deepEqual(await readFile(sceneFile(directory, 's', id)), bytes);
  const another = await store.manage('s', 2, 'create');
  assert.notEqual(another.activeBoardId, id);
  const raw = JSON.parse(await readFile(catalogFile(directory), 'utf8'));
  assert.equal(raw.boards.find((entry) => entry.id === id).deleted, true);
});

test('omitted writes are rejected for multiple boards even after active switches, explicit scene CAS includes boardId', async (t) => {
  const { store } = await setup(t);
  const created = await store.manage('s', 0, 'create');
  const id = created.activeBoardId;
  for (const active of [id, 'default']) {
    if (active === 'default') await store.manage('s', 1, 'activate', { boardId: active });
    assert.equal((await store.get('s')).boardId, active);
    await assert.rejects(store.save('s', 0, scene()), { code: 'validation' });
    await assert.rejects(store.patch('s', 0, []), { code: 'validation' });
  }
  const board = await store.patch('s', 0, [add()], id);
  for (const request of [store.patch('s', 0, [], id), store.save('s', 0, scene(), id)]) {
    await assert.rejects(request, (error) => {
      assert.equal(error.code, 'conflict');
      assert.deepEqual(error.board, board);
      error.board.elements[0].x = 999;
      return true;
    });
  }
  assert.deepEqual(await store.get('s', id), board);
});

test('last-board deletion and unknown explicit ids never create scenes or metadata', async (t) => {
  const { directory, store } = await setup(t);
  await assert.rejects(store.manage('s', 0, 'delete', { boardId: 'default' }), { code: 'validation' });
  const unknown = randomUUID();
  for (const request of [store.get('s', unknown), store.save('s', 0, scene(), unknown), store.patch('s', 0, [], unknown),
    ...['rename', 'activate', 'delete'].map((action) => store.manage('s', 0, action, action === 'rename' ? { boardId: unknown, name: 'no' } : { boardId: unknown }))]) {
    await assert.rejects(request, { code: 'not-found' });
  }
  assert.deepEqual(await readdir(directory), []);
});

test('unsafe ids, revisions, names, options and actions reject before queueing or disk writes', async (t) => {
  const { directory, store } = await setup(t);
  for (const id of ['', ' ', null, 1, 'x'.repeat(257)]) {
    for (const request of [store.list(id), store.get(id), store.manage(id, 0, 'create'), store.patch(id, 0, []), store.save(id, 0, scene())]) await assert.rejects(request, { code: 'validation' });
  }
  for (const id of ['', '../default', '/tmp/evil', 'DEFAULT', randomUUID().toUpperCase(), {}, null, 'a'.repeat(100)]) {
    for (const request of [store.get('s', id), store.patch('s', 0, [], id), store.save('s', 0, scene(), id), store.manage('s', 0, 'activate', { boardId: id })]) await assert.rejects(request, { code: 'validation' });
  }
  for (const base of [-1, NaN, Infinity, 0.1, '0', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    for (const request of [store.manage('s', base, 'create'), store.patch('s', base, []), store.save('s', base, scene())]) await assert.rejects(request, { code: 'validation' });
  }
  for (const value of ['', '  ', 'x'.repeat(81), 'a\nb', '\u0000x', 'a\u0085b', 'a\u202eb', 1, null]) {
    await assert.rejects(store.manage('s', 0, 'create', { name: value }), { code: 'validation' });
    await assert.rejects(store.manage('s', 0, 'rename', { boardId: 'default', name: value }), { code: 'validation' });
  }
  let getterRan = false;
  const getter = Object.defineProperty({}, 'name', { enumerable: true, get() { getterRan = true; throw new Error('do not invoke'); } });
  for (const input of [null, [], new Date(), { extra: true }, Object.create({ name: 'inherited' }), getter,
    JSON.parse('{"__proto__":{}}'), { [Symbol('x')]: 1 }]) await assert.rejects(store.manage('s', 0, 'create', input), { code: 'validation' });
  assert.equal(getterRan, false);
  await assert.rejects(store.manage('s', 0, 'unknown'), { code: 'validation' });
  await assert.rejects(store.manage('s', 0, 'create', { boardId: randomUUID() }), { code: 'validation' });
  await assert.rejects(store.manage('s', 0, 'rename', { boardId: 'default' }), { code: 'validation' });
  await assert.rejects(store.manage('s', 0, 'activate', { boardId: 'default', name: 'extra' }), { code: 'validation' });
  await assert.rejects(store.save('s', 0, { elements: [], constructor: {} }), { code: 'validation' });
  await assert.rejects(store.patch('s', 0, [Object.assign(Object.create({ inherited: true }), add())]), { code: 'validation' });
  assert.deepEqual(await readdir(directory), []);
});

test('session hashing isolates traversal-like session ids, board ids and root legacy scenes', async (t) => {
  const { directory, store } = await setup(t);
  const sessionId = '../../private/path?session=你好';
  const created = await store.manage(sessionId, 0, 'create', { name: '安全' });
  const id = created.activeBoardId;
  await store.patch(sessionId, 0, [add('private')], id);
  await store.patch('other', 0, [add('other')]);
  assert.equal((await store.get(sessionId, id)).sessionId, sessionId);
  assert.deepEqual((await store.get(sessionId, 'default')).elements, []);
  await assert.rejects(store.get('other', id), { code: 'not-found' });
  assert.equal((await store.get('other')).elements[0].id, 'other');
  assert.deepEqual((await store.get('unseen')).elements, []);
  assert.deepEqual(await readdir(path.join(directory, 'boards')), [hash(sessionId)]);
  assert.equal(JSON.parse(await readFile(sceneFile(directory, sessionId, id), 'utf8')).sessionId, sessionId);
});

test('corrupt catalogs, exact schema violations and invalid UTF-8 refuse every overwrite', async (t) => {
  const { directory, store } = await setup(t);
  const malformed = [
    'not json', 'null', '[]', '{}', Buffer.from([0xff, 0xfe, 0x7b]),
    { ...diskCatalog(), sessionId: 'wrong' }, { ...diskCatalog(), revision: -1 }, { ...diskCatalog(), revision: '0' },
    { ...diskCatalog(), activeBoardId: randomUUID() }, { ...diskCatalog(), extra: true },
    { ...diskCatalog(), boards: [] }, { ...diskCatalog(), boards: [{ id: 'default', name: 'x' }] },
    { ...diskCatalog(), boards: [{ id: 'default', name: 'x', deleted: false, extra: true }] },
    { ...diskCatalog(), boards: [{ id: 'default', name: ' x ', deleted: false }] },
    { ...diskCatalog(), boards: [{ id: 'default', name: 'x\ny', deleted: false }] },
    { ...diskCatalog(), boards: [{ id: 'default', name: 'x', deleted: 'false' }] },
    { ...diskCatalog(), boards: [{ id: 'default', name: 'x', deleted: true }] },
    { ...diskCatalog(), boards: [{ id: '../escape', name: 'x', deleted: false }] },
    { ...diskCatalog(), boards: [{ id: 'default', name: 'x', deleted: false }, { id: 'default', name: 'y', deleted: false }] },
    JSON.stringify(diskCatalog()).replace('"revision":0', '"revision":0,"__proto__":{}'),
  ];
  for (const value of malformed) {
    await writeCatalog(directory, value);
    const before = await readFile(catalogFile(directory));
    for (const request of [store.list('s'), store.get('s'), store.manage('s', 0, 'create'), store.save('s', 0, scene()), store.patch('s', 0, [])]) await assert.rejects(request, { code: 'corrupt' });
    assert.deepEqual(await readFile(catalogFile(directory)), before);
  }
  assert.deepEqual(await readdir(directory), ['catalogs']);
});

test('oversized sparse catalogs are checked before reading and cannot be overwritten', async (t) => {
  const { directory, store } = await setup(t);
  await writeCatalog(directory, diskCatalog());
  const handle = await open(catalogFile(directory), 'r+');
  try { await handle.truncate(1024 * 1024 * 1024); } finally { await handle.close(); }
  for (const request of [store.list('s'), store.get('s'), store.manage('s', 0, 'create'), store.patch('s', 0, [])]) await assert.rejects(request, { code: 'corrupt' });
  assert.equal((await stat(catalogFile(directory))).size, 1024 * 1024 * 1024);
});

test('catalog symlinks, dangling links, directories and symlinked catalog directories are refused', async (t) => {
  const { directory, store } = await setup(t);
  const target = path.join(directory, 'target');
  await writeFile(target, JSON.stringify(diskCatalog()));
  await mkdir(path.join(directory, 'catalogs'));
  await symlink(target, catalogFile(directory, 'linked'));
  await symlink(path.join(directory, 'missing-target'), catalogFile(directory, 'dangling'));
  await mkdir(catalogFile(directory, 'directory'));
  for (const sessionId of ['linked', 'dangling', 'directory']) {
    for (const request of [store.list(sessionId), store.get(sessionId), store.manage(sessionId, 0, 'create'), store.save(sessionId, 0, scene())]) await assert.rejects(request, { code: 'corrupt' });
  }
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), diskCatalog());
  const otherRoot = path.join(directory, 'other-root');
  await mkdir(otherRoot);
  await symlink(path.join(directory, 'catalogs'), path.join(otherRoot, 'catalogs'));
  const linked = new WorkspaceStore({ directory: otherRoot });
  t.after(() => linked.dispose());
  await assert.rejects(linked.list('s'), { code: 'corrupt' });
  await assert.rejects(linked.manage('s', 0, 'create'), { code: 'corrupt' });
});

test('symlinked nondefault scene subtree is refused without affecting other sessions', async (t) => {
  const { directory, store } = await setup(t);
  const created = await store.manage('s', 0, 'create');
  const target = path.join(directory, 'target-scenes');
  await mkdir(target);
  await symlink(target, path.join(directory, 'boards'));
  await assert.rejects(store.get('s', created.activeBoardId), { code: 'corrupt' });
  await assert.rejects(store.patch('s', 0, [], created.activeBoardId), { code: 'corrupt' });
  assert.deepEqual(await readdir(target), []);
  assert.equal((await store.patch('other', 0, [add()])).boardId, 'default');
});

test('catalog live and tombstone limits are bounded, ids stay reserved, and full catalogs can still rename', async (t) => {
  const { directory, store } = await setup(t);
  const full = diskCatalog();
  full.boards.push(...Array.from({ length: 99 }, () => ({ id: randomUUID(), name: 'Same', deleted: false })));
  await writeCatalog(directory, full);
  await assert.rejects(store.manage('s', 0, 'create'), { code: 'validation' });
  const deleted = await store.manage('s', 0, 'delete', { boardId: full.boards[1].id });
  const replacement = await store.manage('s', deleted.revision, 'create');
  assert.equal(replacement.boards.length, 100);
  assert.notEqual(replacement.activeBoardId, full.boards[1].id);
  assert.equal(JSON.parse(await readFile(catalogFile(directory), 'utf8')).boards.length, 101);
  const tombstones = diskCatalog();
  tombstones.boards.push(...Array.from({ length: 999 }, () => ({ id: randomUUID(), name: 'Past', deleted: true })));
  await writeCatalog(directory, tombstones);
  await assert.rejects(store.manage('s', 0, 'create'), { code: 'validation' });
  assert.equal((await store.manage('s', 0, 'rename', { boardId: 'default', name: 'Still usable' })).revision, 1);
  for (const invalid of [
    { ...tombstones, boards: [...tombstones.boards, { id: randomUUID(), name: 'overflow', deleted: true }] },
    { ...full, boards: [...full.boards, { id: randomUUID(), name: 'overflow', deleted: false }] },
  ]) {
    await writeCatalog(directory, invalid);
    await assert.rejects(store.list('s'), { code: 'corrupt' });
  }
});

test('catalog revision exhaustion refuses writes without modifying bytes', async (t) => {
  const { directory, store } = await setup(t);
  await writeCatalog(directory, { ...diskCatalog(), revision: Number.MAX_SAFE_INTEGER });
  const before = await readFile(catalogFile(directory));
  await assert.rejects(store.manage('s', Number.MAX_SAFE_INTEGER, 'create'), { code: 'validation' });
  assert.deepEqual(await readFile(catalogFile(directory)), before);
});

test('concurrent instances serialize catalog and scene CAS with exactly one winner', async (t) => {
  const { store, reopen } = await setup(t);
  const other = reopen();
  const creates = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : other).manage('s', 0, 'create')));
  assert.equal(creates.filter((result) => result.status === 'fulfilled').length, 1);
  const current = await store.list('s');
  for (const loser of creates.filter((result) => result.status === 'rejected')) {
    assert.equal(loser.reason.code, 'catalog-conflict');
    assert.deepEqual(loser.reason.catalog, current);
  }
  const id = current.activeBoardId;
  const writes = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : other).patch('s', 0, [add(`n${index}`)], id)));
  assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
  for (const loser of writes.filter((result) => result.status === 'rejected')) {
    assert.equal(loser.reason.code, 'conflict');
    assert.equal(loser.reason.board.boardId, id);
    assert.equal(loser.reason.board.revision, 1);
  }
  assert.deepEqual(await other.list('s'), current);
});

test('catalog lock spans in-flight scene writes, delete and late saves across instances', async (t) => {
  const { directory, store, reopen } = await setup(t);
  const other = reopen();
  const catalog = await store.manage('s', 0, 'create');
  const pause = pauseMethod(store.legacyStore, 'persist');
  const first = store.patch('s', 0, [add('before-delete')], 'default');
  await pause.entered;
  const deletion = other.manage('s', catalog.revision, 'delete', { boardId: 'default' });
  const lateSave = store.save('s', 1, scene([shape('late')]), 'default');
  const latePatch = other.patch('s', 1, [add('later')], 'default');
  // Observe all rejections immediately; the queue is intentionally held until release.
  const settled = Promise.allSettled([first, deletion, lateSave, latePatch]);
  try { assert.equal((await other.patch('independent', 0, [add()])).revision, 1); }
  finally { pause.release(); }
  const results = await settled;
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[2].reason.code, 'not-found');
  assert.equal(results[3].reason.code, 'not-found');
  const bytes = JSON.parse(await readFile(legacyFile(directory), 'utf8'));
  assert.equal(bytes.revision, 1);
  assert.equal(bytes.elements[0].id, 'before-delete');
  assert.equal((await store.get('s')).boardId, catalog.activeBoardId);
});

test('queued create and rename options, save scenes and patch operations are captured before mutation', async (t) => {
  const { store } = await setup(t);
  const pause = pauseMethod(store.legacyStore, 'persist');
  const first = store.patch('s', 0, [add('initial')]);
  await pause.entered;
  const png = { id: 'pixel', mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=', created: 1 };
  const input = scene([shape('saved'), shape('image', { type: 'image', fileId: 'pixel', scale: [1, 1] })], ['saved'], { pixel: png });
  const save = store.save('s', 1, input, 'default');
  const operations = [add('patched', { text: 'Original' })];
  const patch = store.patch('s', 2, operations, 'default');
  const createOptions = { name: ' Original create ' };
  const create = store.manage('s', 0, 'create', createOptions);
  const renameOptions = { boardId: 'default', name: ' Original rename ' };
  const rename = store.manage('s', 1, 'rename', renameOptions);
  input.elements[0].x = 999;
  input.files.pixel.created = 99;
  input.selectedIds.length = 0;
  operations[0].id = 'mutated'; operations[0].text = 'Mutated';
  createOptions.name = 'Mutated';
  renameOptions.boardId = randomUUID(); renameOptions.name = 'Mutated';
  pause.release();
  const [, saved, patched, created, renamed] = await Promise.all([first, save, patch, create, rename]);
  assert.equal(saved.elements[0].x, 0);
  assert.equal(saved.files.pixel.created, 1);
  assert.deepEqual(saved.selectedIds, ['saved']);
  assert.ok(patched.elements.some((element) => element.id === 'patched'));
  assert.ok(patched.elements.some((element) => element.originalText === 'Original'));
  assert.equal(created.boards[1].name, 'Original create');
  assert.equal(renamed.boards[0].name, 'Original rename');
});

test('list/get after creation have no scene-file writes and preserve existing metadata bytes', async (t) => {
  const { directory, store } = await setup(t);
  const catalog = await store.manage('s', 0, 'create');
  const before = await readFile(catalogFile(directory));
  const beforeStat = await stat(catalogFile(directory));
  for (let i = 0; i < 3; i++) {
    await store.list('s');
    await store.get('s');
    await store.get('s', 'default');
  }
  assert.deepEqual(await readdir(directory), ['catalogs']);
  assert.deepEqual(await readFile(catalogFile(directory)), before);
  assert.equal((await stat(catalogFile(directory))).mtimeMs, beforeStat.mtimeMs);
  assert.equal((await store.get('s')).boardId, catalog.activeBoardId);
});

test('catalog persist failure leaves no authoritative cache and queue recovers', async (t) => {
  const { directory, store } = await setup(t);
  const original = store.catalogWriter.persist;
  store.catalogWriter.persist = async () => { throw new Error('injected catalog failure'); };
  await assert.rejects(store.manage('s', 0, 'create'), /injected catalog failure/u);
  assert.deepEqual(await store.list('s'), virtual());
  assert.deepEqual(await readdir(path.join(directory, 'catalogs')), []);
  store.catalogWriter.persist = original;
  assert.equal((await store.manage('s', 0, 'create')).revision, 1);
});

test('dispose drains queued own operations and stores, rejects new work, and leaves other instances usable', async (t) => {
  const { store, reopen } = await setup(t);
  const other = reopen();
  const pause = pauseMethod(store.legacyStore, 'persist');
  const pending = store.patch('s', 0, [add()]);
  await pause.entered;
  const pendingCatalog = store.manage('s', 0, 'create');
  const closing = store.dispose();
  for (const request of [store.list('s'), store.get('s'), store.save('s', 0, scene()), store.patch('s', 0, []), store.manage('s', 0, 'create')]) await assert.rejects(request, { code: 'disposed' });
  pause.release();
  await closing;
  assert.equal((await pending).revision, 1);
  assert.equal((await pendingCatalog).revision, 1);
  assert.equal(store.legacyStore.closed, true);
  assert.equal(store.catalogWriter.closed, true);
  assert.equal((await other.get('s', 'default')).revision, 1);
  const active = (await other.list('s')).activeBoardId;
  assert.equal((await other.patch('s', 0, [add('after')], active)).revision, 1);
  await store.dispose();
});
