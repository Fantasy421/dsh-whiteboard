import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BoardStore } from '../src/store.mjs';
import { emptyBoard, MAX_SCENE_BYTES } from '../src/model.mjs';

const add = (id = 'node', extra = {}) => ({ op: 'add', id, type: 'rectangle', ...extra });
const filename = (directory, sessionId) => path.join(directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
const scene = (elements = [], selectedIds = [], files = {}) => ({ elements, selectedIds, files });
const shape = (id, extra = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 100, height: 100, ...extra });

async function setup(t, Store = BoardStore) {
  const prefix = path.join(os.tmpdir(), 'dsh-whiteboard-store-');
  const directory = await mkdtemp(prefix);
  const store = new Store({ directory });
  t.after(async () => {
    await store.dispose();
    // Verify the exact absolute test-owned cleanup root, never a user-provided path.
    assert.equal(path.dirname(path.resolve(directory)), path.dirname(path.resolve(prefix)));
    assert.ok(path.basename(directory).startsWith('dsh-whiteboard-store-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store };
}

test('get returns isolated empty boards without creating disk files', async (t) => {
  const { store, directory } = await setup(t);
  const one = await store.get('one');
  one.elements.push(shape('fake'));
  assert.deepEqual((await store.get('one')).elements, []);
  assert.equal((await store.get('two')).revision, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('patch persists complete boards across store restarts with SHA256 names and mode 0600', async (t) => {
  const { store, directory } = await setup(t);
  const sessionId = '../../private/path?session=你好';
  const result = await store.patch(sessionId, 0, [add('a', { text: 'Bound label' })]);
  assert.equal(result.revision, 1);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.elements.length, 2);
  const files = await readdir(directory);
  assert.deepEqual(files, [path.basename(filename(directory, sessionId))]);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/u);
  assert.equal((await stat(filename(directory, sessionId))).mode & 0o777, 0o600);
  const reopened = new BoardStore({ directory });
  t.after(() => reopened.dispose());
  assert.deepEqual(await reopened.get(sessionId), result);
  assert.deepEqual(JSON.parse(await readFile(filename(directory, sessionId), 'utf8')), result);
});

test('save persists selection and embedded files and clones input/output', async (t) => {
  const { store } = await setup(t);
  const file = { id: 'pixel', mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=', created: 1 };
  const input = scene([shape('a'), shape('image', { type: 'image', fileId: 'pixel', scale: [1, 1] })], ['a'], { pixel: file });
  const promise = store.save('s', 0, input);
  input.elements[0].x = 900;
  input.files.pixel.created = 123;
  input.selectedIds.length = 0;
  const saved = await promise;
  assert.equal(saved.elements[0].x, 0);
  assert.equal(saved.files.pixel.created, 1);
  assert.deepEqual(saved.selectedIds, ['a']);
  const expected = structuredClone(saved);
  saved.elements[0].x = 77;
  saved.files.pixel.dataURL = 'changed';
  saved.selectedIds.length = 0;
  assert.deepEqual(await store.get('s'), expected);
});

test('same-session simultaneous CAS has exactly one winner, losers get detached latest snapshots', async (t) => {
  const { store } = await setup(t);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.patch('s', 0, [add(`n${i}`)])));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const losers = results.filter((result) => result.status === 'rejected');
  assert.equal(losers.length, 11);
  for (const loser of losers) {
    assert.equal(loser.reason.code, 'conflict');
    assert.equal(loser.reason.board.revision, 1);
  }
  losers[0].reason.board.elements[0].x = 999;
  assert.equal((await store.get('s')).elements[0].x, 0);
  assert.equal(losers[1].reason.board.elements[0].x, 0);
});

test('multiple store instances in this process share per-path serialization', async (t) => {
  const { store, directory } = await setup(t);
  const second = new BoardStore({ directory });
  t.after(() => second.dispose());
  const results = await Promise.allSettled([store.patch('s', 0, [add('a')]), second.patch('s', 0, [add('b')])]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'conflict');
  assert.equal((await second.get('s')).revision, 1);
});

test('distinct sessions do not block one another while reads follow queued writes', async (t) => {
  let release, entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  class PausedStore extends BoardStore {
    async persist(file, board) {
      if (board.sessionId === 'slow') { entered(); await blocked; }
      return super.persist(file, board);
    }
  }
  const { store } = await setup(t, PausedStore);
  const slow = store.patch('slow', 0, [add('a')]);
  await started;
  const queuedRead = store.get('slow');
  try {
    assert.equal((await store.patch('fast', 0, [add('b')])).revision, 1);
  } finally { release(); }
  await slow;
  assert.equal((await queuedRead).revision, 1);
});

test('queued patch input is captured before callers mutate it', async (t) => {
  const { store } = await setup(t);
  const ops = [add('a', { text: 'Original' })];
  const promise = store.patch('s', 0, ops);
  ops[0].id = 'changed'; ops[0].text = 'Changed';
  const board = await promise;
  assert.equal(board.elements[0].id, 'a');
  assert.equal(board.elements[1].originalText, 'Original');
});

test('invalid batches never mutate the board on disk or increment revision; queues recover', async (t) => {
  const { store, directory } = await setup(t);
  const before = await store.patch('s', 0, [add('a')]);
  const bytes = await readFile(filename(directory, 's'), 'utf8');
  await assert.rejects(store.patch('s', 1, [{ op: 'update', id: 'a', x: 50 }, { op: 'update', id: 'missing', x: 1 }]), { code: 'validation' });
  assert.equal(await readFile(filename(directory, 's'), 'utf8'), bytes);
  assert.deepEqual(await store.get('s'), before);
  const result = await store.patch('s', 1, [{ op: 'update', id: 'a', x: 25 }]);
  assert.equal(result.revision, 2);
  assert.equal(result.elements[0].x, 25);
});

test('invalid revisions and session ids reject without touching disk', async (t) => {
  const { store, directory } = await setup(t);
  for (const base of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined]) {
    await assert.rejects(store.patch('s', base, []), { code: 'validation' });
    await assert.rejects(store.save('s', base, scene()), { code: 'validation' });
  }
  for (const sessionId of ['', ' ', 1, null, 'x'.repeat(257)]) {
    await assert.rejects(store.get(sessionId), { code: 'validation' });
    await assert.rejects(store.patch(sessionId, 0, []), { code: 'validation' });
    await assert.rejects(store.save(sessionId, 0, scene()), { code: 'validation' });
  }
  assert.deepEqual(await readdir(directory), []);
});

test('save and patch reject stale CAS and report latest full scene', async (t) => {
  const { store } = await setup(t);
  const current = await store.save('s', 0, scene([shape('a')], ['a']));
  for (const request of [store.save('s', 0, scene()), store.patch('s', 0, [])]) {
    await assert.rejects(request, (error) => error.code === 'conflict' && assert.deepEqual(error.board, current) === undefined);
  }
  assert.deepEqual(await store.get('s'), current);
});

test('corrupted, polluted, mismatched or oversized files are never silently overwritten', async (t) => {
  const { store, directory } = await setup(t);
  const cases = ['not json', '{"sessionId":"bad","revision":0}', JSON.stringify({ ...emptyBoard('s'), revision: -1 }),
    '{"sessionId":"s","revision":0,"updatedAt":"2026-01-01","elements":[],"files":{},"selectedIds":[],"__proto__":{}}',
    JSON.stringify({ ...emptyBoard('s'), elements: [shape('a', { x: 'bad' })] }), ' '.repeat(MAX_SCENE_BYTES + 16385)];
  for (const contents of cases) {
    await writeFile(filename(directory, 's'), contents);
    await assert.rejects(store.get('s'), { code: 'corrupt' });
    await assert.rejects(store.save('s', 0, scene()), { code: 'corrupt' });
    await assert.rejects(store.patch('s', 0, []), { code: 'corrupt' });
    assert.equal(await readFile(filename(directory, 's'), 'utf8'), contents);
  }
});

test('symlinks are not followed as board files', async (t) => {
  const { store, directory } = await setup(t);
  const target = path.join(directory, 'target');
  await writeFile(target, JSON.stringify(emptyBoard('s')));
  await symlink(target, filename(directory, 's'));
  await assert.rejects(store.get('s'), { code: 'corrupt' });
  await assert.rejects(store.patch('s', 0, []), { code: 'corrupt' });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), emptyBoardWithTime(await readFile(target, 'utf8')));
});
function emptyBoardWithTime(json) { const parsed = JSON.parse(json); return { ...emptyBoard('s'), updatedAt: parsed.updatedAt }; }

test('persist failures leave no temp files and do not report a successful revision', async (t) => {
  class FailingStore extends BoardStore {
    async persist(file, board) { await mkdir(file); return super.persist(file, board); }
  }
  const { store, directory } = await setup(t, FailingStore);
  await assert.rejects(store.patch('s', 0, [add('a')]), (error) => ['EISDIR', 'ENOTEMPTY', 'EEXIST'].includes(error.code));
  assert.deepEqual(await readdir(directory), [path.basename(filename(directory, 's'))]);
  assert.equal((await stat(filename(directory, 's'))).isDirectory(), true);
});

test('failed writes have no in-memory revision cache and a later valid write starts at zero', async (t) => {
  const { store } = await setup(t);
  const original = store.persist;
  store.persist = async () => { throw new Error('injected write failure'); };
  await assert.rejects(store.patch('s', 0, [add('a')]), /injected write failure/u);
  assert.equal((await store.get('s')).revision, 0);
  store.persist = original;
  assert.equal((await store.patch('s', 0, [add('b')])).revision, 1);
});

test('native omission preserves tombstones; AI cannot reuse them; native undo restores same identity', async (t) => {
  const { store } = await setup(t);
  const initial = await store.patch('s', 0, [add('a')]);
  const deleted = await store.save('s', 1, scene());
  assert.equal(deleted.elements.length, 1);
  assert.equal(deleted.elements[0].isDeleted, true);
  await assert.rejects(store.patch('s', 2, [add('a')]), { code: 'validation' });
  await assert.rejects(store.save('s', 2, scene(initial.elements)), { code: 'validation' });
  const restored = structuredClone(initial.elements);
  restored[0].version = deleted.elements[0].version + 1;
  const undone = await store.save('s', 2, scene(restored));
  assert.equal(undone.revision, 3);
  assert.equal(undone.elements[0].isDeleted, false);
  const impostor = structuredClone(undone.elements);
  impostor[0].seed++;
  await assert.rejects(store.save('s', 3, scene(impostor)), { code: 'validation' });
  assert.equal((await store.get('s')).revision, 3);
});

test('human-native frame arrow bindings survive save and disk roundtrip', async (t) => {
  const { store, directory } = await setup(t);
  const native = scene([
    shape('frame', { type: 'frame', name: 'Human frame', boundElements: [{ id: 'arrow', type: 'arrow' }] }),
    shape('arrow', { type: 'arrow', points: [[0, 0], [200, 0]], startBinding: { elementId: 'frame', focus: 0, gap: 8 }, endBinding: null }),
  ]);
  const saved = await store.save('s', 0, native);
  const reopened = new BoardStore({ directory });
  t.after(() => reopened.dispose());
  assert.deepEqual(await reopened.get('s'), saved);
  assert.equal(saved.elements[1].startBinding.elementId, 'frame');
  const replaced = structuredClone(native);
  replaced.elements[0].name = 'Renamed frame';
  const updated = await store.save('s', 1, replaced);
  assert.equal(updated.revision, 2);
  assert.equal(updated.elements[1].startBinding.elementId, 'frame');
});

test('malicious native scene and operation prototypes are rejected before entering queues', async (t) => {
  const { store, directory } = await setup(t);
  await assert.rejects(store.save('s', 0, JSON.parse('{"elements":[],"files":{},"selectedIds":[],"constructor":{}}')), { code: 'validation' });
  const operation = Object.assign(Object.create({ inherited: true }), add('a'));
  await assert.rejects(store.patch('s', 0, [operation]), { code: 'validation' });
  const getter = add('b');
  Object.defineProperty(getter, 'text', { enumerable: true, get() { throw new Error('getter must not run'); } });
  await assert.rejects(store.patch('s', 0, [getter]), { code: 'validation' });
  assert.deepEqual(await readdir(directory), []);
});

test('dispose drains in-flight work and rejects new operations', async (t) => {
  const { store } = await setup(t);
  const pending = store.patch('s', 0, [add('a')]);
  await store.dispose();
  assert.equal((await pending).revision, 1);
  await assert.rejects(store.get('s'), { code: 'disposed' });
  await assert.rejects(store.save('s', 1, scene()), { code: 'disposed' });
  await assert.rejects(store.patch('s', 1, []), { code: 'disposed' });
});
