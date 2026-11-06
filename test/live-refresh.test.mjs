import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate as settle } from 'node:timers/promises';
import { BoardSync, sceneOf } from '../src/sync.mjs';
import { applyOperations } from '../src/model.mjs';
import { BoardStore } from '../src/store.mjs';
import { createRpcHandler } from '../src/rpc.mjs';

// Exercise the actual client RPC adapter + sync + disk-backed handler. The
// transport fault is synthetic; this is not a browser or live-network test.
async function clientRpc(t, transport) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = join(root, 'node_modules', `.live-refresh-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } };
  globalThis.window = {};
  const result = await build({ entryPoints: [join(root, 'src/client.jsx')], bundle: true, write: false, platform: 'node', format: 'esm', conditions: ['production'], external: ['react', 'react-dom'], loader: { '.css': 'text', '.woff2': 'dataurl' }, plugins: [{ name: 'no-editor', setup(b) {
    b.onResolve({ filter: /\.\/Whiteboard\.jsx$/ }, () => ({ path: 'editor', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function Whiteboard() { return null; }' }));
  } }] });
  await writeFile(output, result.outputFiles[0].text);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    assert.equal(dirname(output), join(root, 'node_modules'));
    await unlink(output);
  });
  const { apply } = await import(pathToFileURL(output).href);
  let Body;
  apply({ effect: effect => effect(), connection: { rpc: { call: transport } }, sidebarRightTabs: { register() {} }, slots: {
    inject: (_name, register) => register(),
    register: (definition, Component) => { if (definition.name === 'sidebar.right.pane.tab') Body = Component; },
  } });
  return Body({ sessionId: 'refresh-test', useTabInfo: () => ({ tab: { visible: true } }) }).props.rpc;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-live-refresh-'));
  const store = new BoardStore({ directory });
  t.after(async () => { await store.dispose(); assert.ok(directory.startsWith(join(tmpdir(), 'dsh-live-refresh-'))); await rm(directory, { recursive: true, force: true }); });
  const handler = createRpcHandler(store);
  const respond = async payload => (await handler(new Request('http://localhost/api/dsh-whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'dsh-whiteboard', payload }) }))).json().then(reply => reply.result);
  return { store, respond };
}

test('open sync resumes after a stalled poll without recreating the sidebar', async t => {
  const { store, respond } = await fixture(t);
  let reads = 0, stalledSignal;
  const rpc = await clientRpc(t, async (_path, _method, payload, signal) => {
    if (payload.method === 'get' && ++reads === 2) { stalledSignal = signal; return new Promise(() => {}); }
    return respond(payload);
  });
  const displayed = [];
  const sync = new BoardSync({ read: () => rpc('get', { sessionId: 'refresh-test' }), write: (baseRevision, scene) => rpc('save', { sessionId: 'refresh-test', baseRevision, scene }), onScene: scene => displayed.push(structuredClone(scene)) });
  t.after(() => sync.dispose());
  await sync.start();
  await store.patch('refresh-test', 0, [{ op: 'add', id: 'ai-live', type: 'rectangle', x: 20, y: 30 }]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = sync.tick();
  await settle();
  t.mock.timers.tick(10001);
  await settle();
  assert.equal(sync.inflight, null, 'a stalled poll must expire so the next scheduled tick can read again');
  await stalled;
  await sync.tick();
  assert.equal(reads, 3);
  assert.ok(displayed.at(-1).elements.some(element => element.id === 'ai-live'), 'AI changes must reach the same mounted sync owner');
  assert.equal(stalledSignal?.aborted, true, 'the expired transport must be cancelled too');
});

test('a timed-out committed save recovers via CAS without duplicate writes or lost local edits', async t => {
  const { store, respond } = await fixture(t);
  let saves = 0, acknowledgeLate, committed;
  const saved = new Promise(resolve => { committed = resolve; });
  const rpc = await clientRpc(t, async (_path, _method, payload) => {
    if (payload.method === 'save' && ++saves === 1) {
      const response = await respond(payload);
      committed();
      return new Promise(resolve => { acknowledgeLate = () => resolve(response); });
    }
    return respond(payload);
  });
  const sync = new BoardSync({ read: () => rpc('get', { sessionId: 'refresh-test' }), write: (baseRevision, scene) => rpc('save', { sessionId: 'refresh-test', baseRevision, scene }), onScene() {} });
  t.after(() => sync.dispose());
  await sync.start();
  sync.observe(sceneOf(applyOperations(await store.get('refresh-test'), [{ op: 'add', id: 'human-edit', type: 'rectangle', x: 50, y: 60 }])));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = sync.tick();
  await saved;
  // Native editing continues while the successful save's response is missing.
  sync.observe({ ...sync.local, elements: sync.local.elements.map(element => ({ ...element, x: 70, version: element.version + 1 })) });
  t.mock.timers.tick(10001);
  await stalled;
  assert.equal(sync.dirty, true);
  await sync.tick();
  assert.equal(sync.paused, false, 'a lost acknowledgement must not turn newer local edits into a false conflict');
  assert.equal(sync.dirty, false);
  assert.equal(sync.local.elements[0].id, 'human-edit');
  assert.equal(sync.local.elements[0].x, 70);
  assert.equal((await store.get('refresh-test')).revision, 2, 'only the original save and the newer human edit may commit');
  acknowledgeLate();
  await settle();
  assert.equal(sync.base.revision, 2, 'late acknowledgements cannot roll back current state');
});

test('owner abort cancels RPC even if the underlying transport never settles', async t => {
  let transportSignal, calls = 0;
  const rpc = await clientRpc(t, (_path, _method, _payload, signal) => {
    calls++; transportSignal = signal; return new Promise(() => {});
  });
  const controller = new AbortController();
  const pending = rpc('get', { sessionId: 'refresh-test' }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await settle();
  controller.abort();
  await rejected;
  assert.equal(calls, 1);
  assert.equal(transportSignal.aborted, true);
  const closed = new AbortController(); closed.abort();
  await assert.rejects(rpc('get', { sessionId: 'another-session' }, closed.signal), { name: 'AbortError' });
  assert.equal(calls, 1, 'an already-closed owner must never start transport work');
});
