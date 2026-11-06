import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/workspace.mjs';
import { createRpcHandler } from '../src/rpc.mjs';
import { BoardSync } from '../src/sync.mjs';
import { recoveryFor } from '../src/recovery.mjs';

const empty = { elements: [], files: {}, selectedIds: [] };
test('real RPC catalog CRUD and explicit scene targets keep separate CAS domains', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wb-multi-rpc-'));
  const store = new WorkspaceStore({ directory });
  t.after(async () => {
    await store.dispose();
    if (!directory.startsWith(join(tmpdir(), 'dsh-wb-multi-rpc-'))) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true });
  });
  const handle = createRpcHandler(store);
  async function call(method, payload) {
    const response = await handle(new Request('http://localhost/api/dsh-whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'multi', method: 'dsh-whiteboard', payload: { method, payload: { sessionId: 's', ...payload } } }) }));
    const envelope = await response.json();
    assert.equal(envelope.rpcId, 'multi');
    return envelope.result;
  }
  assert.equal((await call('list')).value.activeBoardId, 'default');
  const created = await call('manage', { baseRevision: 0, action: 'create', name: 'Second' });
  assert.equal(created.ok, true);
  const id = created.value.activeBoardId;
  assert.notEqual(id, 'default');
  assert.equal((await call('get')).value.boardId, id);
  const saved = await call('save', { boardId: id, baseRevision: 0, scene: empty });
  assert.equal(saved.value.revision, 1); assert.equal(saved.value.boardId, id);
  assert.equal((await call('get', { boardId: 'default' })).value.revision, 0);
  const ambiguous = await call('save', { baseRevision: 0, scene: empty });
  assert.equal(ambiguous.ok, false); assert.match(ambiguous.error.message, /Explicit boardId/);
  const staleScene = await call('save', { boardId: id, baseRevision: 0, scene: empty });
  assert.equal(staleScene.error.code, 'whiteboard/conflict');
  assert.equal(staleScene.error.details.board.boardId, id);
  const renamed = await call('manage', { action: 'rename', boardId: id, name: 'Architecture', baseRevision: 1 });
  assert.equal(renamed.value.boards.find(b => b.id === id).name, 'Architecture');
  const activated = await call('manage', { action: 'activate', boardId: 'default', baseRevision: 2 });
  assert.equal(activated.value.activeBoardId, 'default');
  const staleCatalog = await call('manage', { action: 'create', baseRevision: 2 });
  assert.equal(staleCatalog.error.code, 'whiteboard/catalog-conflict');
  assert.equal(staleCatalog.error.details.catalog.revision, 3);
  const deleted = await call('manage', { action: 'delete', boardId: id, baseRevision: 3 });
  assert.equal(deleted.value.boards.length, 1);
  assert.equal((await call('get', { boardId: id })).error.code, 'whiteboard/not-found');
  assert.equal((await call('save', { boardId: id, baseRevision: 1, scene: empty })).error.code, 'whiteboard/not-found');
  assert.equal((await call('manage', { action: 'delete', boardId: 'default', baseRevision: 4 })).ok, false);
});

test('board recovery keys preserve legacy drafts and isolate session/board identities', () => {
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const draft = (sessionId, boardId) => ({ base: { sessionId, boardId, revision: 0, ...empty }, local: empty });
  const legacy = recoveryFor('s', 'default', storage);
  const second = recoveryFor('s', 'second', storage);
  const other = recoveryFor('other', 'second', storage);
  const legacyDraft = draft('s', undefined);
  values.set('dsh-whiteboard:recovery:s', JSON.stringify(legacyDraft));
  assert.deepEqual(legacy.load(), JSON.parse(JSON.stringify(legacyDraft)));
  second.save(draft('s', 'second')); other.save(draft('other', 'second'));
  assert.equal(values.size, 3);
  legacy.clear(); assert.equal(second.load().base.sessionId, 's'); assert.equal(other.load().base.sessionId, 'other');
  second.save(draft('other', 'second'));
  assert.throws(() => second.load(), /different whiteboard/);
  second.save(draft('s', 'wrong-board'));
  assert.throws(() => second.load(), /different whiteboard/);
});

test('closing an owner before its first read cannot delete an existing recovery draft', async () => {
  let finishRead;
  const previous = { base: { sessionId: 's', boardId: 'default', revision: 0, ...empty }, local: empty };
  let saved = previous;
  const sync = new BoardSync({ read: () => new Promise(resolve => { finishRead = resolve; }), write: () => { throw new Error('Unexpected save'); }, onScene: () => { throw new Error('Disposed owner rendered'); }, recovery: { load: () => saved, save: value => { saved = value; }, clear: () => { saved = null; } } });
  const starting = sync.start();
  sync.dispose(); assert.equal(saved, previous);
  finishRead({ sessionId: 's', boardId: 'default', revision: 0, ...empty });
  await starting;
  assert.equal(saved, previous);
});
