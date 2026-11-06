import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardSync, mergeScenes, sceneOf } from '../src/sync.mjs';
const element = (id, x = 0) => ({ id, type: 'rectangle', x, isDeleted: false });
const scene = (...elements) => ({ elements, files: {}, selectedIds: [] });
const board = (revision, value) => ({ sessionId: 's1', revision, ...value });

test('three-way merge preserves disjoint human + AI edits', () => {
  const base = scene(element('a'), element('b'));
  const merged = mergeScenes(base, scene(element('a', 20), element('b')), scene(element('a'), element('b', 90), element('c')));
  assert.deepEqual(merged.elements.map(e => [e.id, e.x]), [['a', 20], ['b', 90], ['c', 0]]);
});
test('native fractional indices preserve local bring-to-front during disjoint merge', () => {
  const a = { ...element('a'), index: 'a0' }, b = { ...element('b'), index: 'a1' };
  const local = scene(b, { ...a, index: 'a2' });
  const remote = scene(a, b, { ...element('c'), index: 'a3' });
  assert.deepEqual(mergeScenes(scene(a, b), local, remote).elements.map(e => e.id), ['b', 'a', 'c']);
});
test('legacy local reordering survives merge and divergent concurrent reordering conflicts', () => {
  const a = element('a'), b = element('b'), c = element('c');
  assert.deepEqual(mergeScenes(scene(a, b), scene(b, a), scene(a, b, c)).elements.map(e => e.id), ['b', 'a', 'c']);
  assert.throws(() => mergeScenes(scene(a, b, c), scene(b, a, c), scene(a, c, b)), /order:elements/);
});
test('same-element conflict never silently overwrites either edit', () => {
  assert.throws(() => mergeScenes(scene(element('a')), scene(element('a', 20)), scene(element('a', 30))), /同时修改/);
});
test('graph deletion conflicting with concurrent new bound text is rejected', () => {
  const base = scene(element('a'));
  const local = scene(element('a'), { ...element('text'), type: 'text', containerId: 'a' });
  assert.throws(() => mergeScenes(base, local, scene({ ...element('a'), isDeleted: true })), /binding/);
});
test('edits during in-flight save survive and remain dirty', async () => {
  let resolveWrite;
  let current = board(0, scene(element('a')));
  const sync = new BoardSync({ read: async () => current, write: async (_rev, value) => new Promise(resolve => { resolveWrite = () => { current = board(1, value); resolve(current); }; }), onScene() {} });
  await sync.start(); sync.observe(scene(element('a', 10)));
  const pending = sync.tick();
  sync.observe(scene(element('a', 20)));
  resolveWrite(); await pending;
  assert.equal(sync.local.elements[0].x, 20); assert.equal(sync.base.revision, 1);
  assert.equal(sync.dirty, true); assert.equal(sync.paused, false);
});
test('CAS conflict merges disjoint changes then saves against new revision', async () => {
  let current = board(0, scene(element('a'), element('b')));
  const seen = [];
  const sync = new BoardSync({ read: async () => current, write: async (revision, value) => {
    seen.push(revision);
    if (revision !== current.revision) throw Object.assign(new Error('revision'), { code: 'whiteboard/conflict', details: { board: current } });
    current = board(revision + 1, value); return current;
  }, onScene() {} });
  await sync.start(); sync.observe(scene(element('a', 10), element('b')));
  current = board(1, scene(element('a'), element('b', 20)));
  await sync.tick(); assert.equal(sync.paused, false); assert.equal(sync.dirty, true);
  await sync.tick(); assert.deepEqual(seen, [0, 1]); assert.equal(sync.dirty, false);
  assert.deepEqual(current.elements.map(e => e.x), [10, 20]);
});
test('CAS conflict on same ID pauses and retains local recovery', async () => {
  const recovery = { saved: null, load() { return null; }, save(value) { this.saved = value; }, clear() { this.saved = null; } };
  const initial = board(0, scene(element('a')));
  const sync = new BoardSync({ read: async () => initial, write: async () => { throw Object.assign(new Error('stale'), { code: 'whiteboard/conflict', board: board(1, scene(element('a', 30))) }); }, recovery, onScene() {} });
  await sync.start(); sync.observe(scene(element('a', 20))); await sync.tick();
  assert.equal(sync.paused, true); assert.equal(sync.local.elements[0].x, 20); assert.ok(recovery.saved);
});
test('recovery on reopened session merges against server, without mixing sessions', async () => {
  const base = board(0, scene(element('a'), element('b')));
  const mine = scene(element('a', 20), element('b'));
  const sync = new BoardSync({ read: async () => board(1, scene(element('a'), element('b', 30))), recovery: { load: () => ({ base, local: mine }) }, onScene() {} });
  await sync.start(); assert.deepEqual(sync.local.elements.map(e => e.x), [20, 30]); assert.equal(sync.dirty, true);
});
test('dispose prevents late read from applying into a different session', async () => {
  let resolve; let applied = false;
  const sync = new BoardSync({ read: () => new Promise(r => { resolve = r; }), onScene() { applied = true; } });
  const pending = sync.start(); sync.dispose(); resolve(board(0, scene())); await pending;
  assert.equal(applied, false);
});
test('normalization uses the same canonical baseline for load, incoming updates, save and recovery', async () => {
  const normalize = value => ({ ...value, elements: value.elements.map(e => ({ ...e, boundElements: e.boundElements ?? [] })) });
  let current = board(0, scene({ ...element('a'), boundElements: null }));
  const recovery = { load: () => null, save(value) { this.saved = structuredClone(value); }, clear() {} };
  const sync = new BoardSync({ read: async () => current, write: async (revision, value) => current = board(revision + 1, value), normalize, recovery, onScene() {} });
  await sync.start(); sync.observe(normalize(sceneOf(current))); assert.equal(sync.dirty, false);
  current = board(1, scene({ ...element('a', 90), boundElements: null }));
  await sync.tick(); assert.equal(sync.paused, false); assert.equal(sync.local.elements[0].x, 90); assert.equal(sync.dirty, false);
  sync.observe(normalize(scene({ ...element('a', 100), boundElements: null })));
  assert.deepEqual(recovery.saved.base.elements[0].boundElements, []);
  await sync.tick(); assert.equal(sync.dirty, false);
  sync.observe(normalize(scene(element('a', 110)))); const saved = recovery.saved;
  const reopened = new BoardSync({ read: async () => current, normalize, recovery: { load: () => saved }, onScene() {} });
  await reopened.start(); assert.equal(reopened.paused, false); assert.equal(reopened.local.elements[0].x, 110);
  await reopened.discardLocalAndReload(); assert.equal(reopened.dirty, false); assert.equal(reopened.local.elements[0].x, 100);
});
test('concurrent frame deletion versus child placement conflicts instead of saving dangling frameId', () => {
  const frame = { ...element('f'), type: 'frame' }, child = element('c');
  assert.throws(() => mergeScenes(scene(frame, child), scene(frame, { ...child, frameId: 'f' }), scene({ ...frame, isDeleted: true }, child)), /binding:c:f/);
});
test('reopening recovers edits made after a committed save lost its acknowledgement', async () => {
  let current = board(0, scene(element('a')));
  const recovery = { load() { return this.saved; }, save(value) { this.saved = structuredClone(value); }, clear() { this.saved = null; } };
  const sync = new BoardSync({ read: async () => current, write: async (revision, value) => { current = board(revision + 1, value); throw new Error('lost acknowledgement'); }, recovery, onScene() {} });
  await sync.start(); sync.observe(scene(element('a', 10))); await sync.tick();
  sync.observe(scene(element('a', 20))); sync.dispose();
  assert.equal(recovery.saved.uncertainWrite.scene.elements[0].x, 10);
  const reopened = new BoardSync({ read: async () => current, write: async (revision, value) => current = board(revision + 1, value), recovery, onScene() {} });
  await reopened.start();
  assert.equal(reopened.paused, false);
  assert.equal(reopened.local.elements[0].x, 20);
  await reopened.tick();
  assert.equal(current.revision, 2); assert.equal(current.elements[0].x, 20);
  assert.equal(recovery.saved, null);
});

test('uncertain save recovery does not disguise genuinely conflicting remote edits', async () => {
  let current = board(0, scene(element('a')));
  const sync = new BoardSync({ read: async () => current, write: async (revision, value) => { current = board(revision + 1, value); throw new Error('lost acknowledgement'); }, onScene() {} });
  await sync.start(); sync.observe(scene(element('a', 10))); await sync.tick();
  sync.observe(scene(element('a', 20)));
  current = board(2, scene(element('a', 30))); // another editor changed the same object
  await sync.tick();
  assert.equal(sync.paused, true);
  assert.equal(sync.local.elements[0].x, 20);
  assert.equal(current.elements[0].x, 30);
});

test('failed network save retains local scene and retries on next tick', async () => {
  let fail = true; let current = board(0, scene(element('a')));
  const sync = new BoardSync({ read: async () => current, write: async (revision, value) => { if (fail) throw new Error('offline'); return current = board(revision + 1, value); }, onScene() {} });
  await sync.start(); sync.observe(scene(element('a', 42))); await sync.tick();
  assert.equal(sync.dirty, true); assert.equal(sync.paused, false);
  fail = false; await sync.tick(); assert.equal(sync.dirty, false); assert.equal(current.elements[0].x, 42);
});
