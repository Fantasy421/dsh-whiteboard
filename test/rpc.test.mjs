import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRpcHandler } from '../src/rpc.mjs';
import { BoardStore } from '../src/store.mjs';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wb-rpc-'));
  // Verified mkdtemp result; cleanup only this test-owned directory.
  t.after(async () => { if (!directory.startsWith(join(tmpdir(), 'dsh-wb-rpc-'))) throw new Error('Unsafe cleanup'); await rm(directory, { recursive: true }); });
  const store = new BoardStore({ directory });
  t.after(() => store.dispose());
  return { store, handler: createRpcHandler(store) };
}
const request = (method, payload) => new Request('http://localhost/api/dsh-whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test-call', method: 'dsh-whiteboard', payload: { method, payload } }) });
test('RPC carrier returns native correlation envelope and persists a scene', async t => {
  const { handler } = await fixture(t);
  const response = await handler(request('get', { sessionId: 's1' }));
  const envelope = await response.json();
  assert.equal(envelope.type, 'server-response'); assert.equal(envelope.rpcId, 'test-call');
  assert.equal(envelope.result.ok, true); assert.equal(envelope.result.value.revision, 0);
  const saved = await (await handler(request('save', { sessionId: 's1', baseRevision: 0, scene: { elements: [], files: {}, selectedIds: [] } }))).json();
  assert.equal(saved.result.ok, true); assert.equal(saved.result.value.revision, 1);
  const isolated = await (await handler(request('get', { sessionId: 's2' }))).json();
  assert.equal(isolated.result.value.revision, 0);
});
test('CAS error exposes latest snapshot for non-destructive client merge', async t => {
  const { store, handler } = await fixture(t);
  await store.save('s1', 0, { elements: [], files: {}, selectedIds: [] });
  const response = await (await handler(request('save', { sessionId: 's1', baseRevision: 0, scene: { elements: [], files: {}, selectedIds: [] } }))).json();
  assert.equal(response.result.ok, false); assert.equal(response.result.error.code, 'whiteboard/conflict');
  assert.equal(response.result.error.details.board.revision, 1);
});
test('rejects invalid JSON, method, content type, envelope and unknown operation', async t => {
  const { handler } = await fixture(t);
  assert.equal((await handler(new Request('http://localhost/api/dsh-whiteboard'))).status, 405);
  assert.equal((await handler(new Request('http://localhost/api/dsh-whiteboard', { method: 'POST', body: 'no' }))).status, 415);
  assert.equal((await handler(new Request('http://localhost/api/dsh-whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status, 400);
  const invalid = await (await handler(new Request('http://localhost/api/dsh-whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' }))).json();
  assert.equal(invalid.result.ok, false);
  const unknown = await (await handler(request('execute', { sessionId: 's1' }))).json();
  assert.equal(unknown.result.ok, false);
});
