import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { create, act } from 'react-test-renderer';

// Lifecycle regression, NOT browser proof. Excalidraw 0.18.0 upstream bundle refs:
// dist/dev/index.js:30535-30538: componentDidUpdate always calls props.onChange.
// dist/dev/index.js:33038-33040: memo comparison rejects changed children identity.
// dist/dev/index.js:25957-25962: updateScene shallow-applies appState, replaces scene.
// dist/dev/index.js:28291-28337: pointer-down inserts embed and retains newElement.
// A mount-only native stub misses the synchronous parent/native rejection loop.
const nativeStub = `
import React from 'react';
class NativeApp extends React.Component {
  state = { revision: 0 };
  componentDidMount() {
    globalThis.__embedRejection.native = this;
    globalThis.__embedRejection.mounts++;
    this.props.excalidrawAPI(globalThis.__embedRejection.api);
  }
  componentDidUpdate() {
    const h = globalThis.__embedRejection;
    if (++h.callbacks > 150) throw new Error('Native lifecycle regression exceeded callback budget');
    this.props.onChange(h.elements, h.appState, h.files);
  }
  componentWillUnmount() { globalThis.__embedRejection.unmounts++; }
  render() { return React.createElement('native-editor', this.props); }
}
export const Excalidraw = React.memo(NativeApp, (prev, next) => {
  if (prev.children !== next.children) return false;
  return Object.keys(next).every(key => prev[key] === next[key]);
});
export function MainMenu({children}) { return children; }
MainMenu.DefaultItems = {ClearCanvas: () => null, ToggleTheme: () => null};
export const CaptureUpdateAction = {NEVER:'NEVER', IMMEDIATELY:'IMMEDIATELY'};
export const restoreElements = elements => elements;
export const newElementWith = (element, updates) => ({...element, ...updates});
export const exportToBlob = () => null;
export const exportToSvg = () => null;
export const serializeAsJSON = () => '';
`;

test('unsupported embed rejection breaks native onChange feedback without losing draft or undo', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = join(root, 'node_modules', `.embed-rejection-${process.pid}.mjs`);
  const keys = ['document', 'window', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', '__embedRejection'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalConsoleError = console.error;
  const anticipatedReactErrors = [];
  const pendingMicrotasks = [];
  class Node {
    children = []; parentNode = null; className = '';
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    contains(child) { return this === child || this.children.some(node => node.contains?.(child)); }
    focus() { document.activeElement = this; }
  }
  const fixture = { id: 'existing', type: 'rectangle', x: 0, y: 0, width: 80, height: 40, angle: 0, version: 1, versionNonce: 1, isDeleted: false, locked: false };
  const h = {
    elements: [], files: {}, callbacks: 0, mounts: 0, unmounts: 0,
    appState: { zoom: { value: 1 }, width: 600, height: 400, scrollX: 0, scrollY: 0, selectedElementIds: {}, activeTool: { type: 'selection', customType: null, locked: false, lastActiveTool: null }, newElement: null },
    changes: [], undo: [], historyClears: 0,
  };
  const rerender = () => h.native.setState(state => ({ revision: state.revision + 1 }));
  h.api = {
    getAppState: () => h.appState,
    getSceneElements: () => h.elements.filter(element => !element.isDeleted),
    getSceneElementsIncludingDeleted: () => h.elements,
    getFiles: () => h.files,
    addFiles() {}, refresh() {}, scrollToContent() {},
    history: { clear() { h.historyClears++; h.undo.length = 0; } },
    setActiveTool(tool) { h.appState.activeTool = { ...h.appState.activeTool, ...tool, customType: null }; rerender(); },
    updateScene(change) {
      h.changes.push(structuredClone(change));
      if (change.elements) h.elements = change.elements;
      Object.assign(h.appState, change.appState);
      rerender();
    },
  };
  const storage = new Map();
  let renderer, reads = 0, writes = 0;
  try {
    globalThis.document = { body: new Node(), activeElement: null, createElement: () => new Node() };
    globalThis.window = new EventTarget();
    globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = clearTimeout;
    // Explicitly hold only the rollback microtask queue: assertions can inspect
    // synchronous lifecycle completion BEFORE allowing deferred repair to run.
    globalThis.queueMicrotask = callback => pendingMicrotasks.push(callback);
    globalThis.__embedRejection = h;
    console.error = (...args) => {
      const message = args.map(String).join(' ');
      if (message.includes('The above error occurred in the <NativeApp> component')) anticipatedReactErrors.push(message);
      else originalConsoleError(...args);
    };
    const result = await build({
      stdin: { contents: `export { Whiteboard } from './src/Whiteboard.jsx';`, resolveDir: root, loader: 'jsx' },
      bundle: true, write: false, format: 'esm', platform: 'node', external: ['react'],
      plugins: [{ name: 'native-rejection-lifecycle', setup(build) {
        build.onResolve({ filter: /^(@excalidraw\/excalidraw|react-dom)$/ }, args => ({ path: args.path, namespace: 'rejection-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'rejection-stub' }, args => ({ loader: 'js', contents: args.path === 'react-dom'
          ? `import React from 'react'; export const createPortal = (children, container) => React.createElement('portal', {container}, children);`
          : nativeStub }));
      } }],
    });
    await writeFile(output, result.outputFiles[0].text);
    const { Whiteboard } = await import(pathToFileURL(output).href);
    const rpc = async (method, payload) => {
      if (method === 'save') { writes++; throw new Error('fixture writes are intentionally offline'); }
      reads++;
      return { sessionId: payload.sessionId, boardId: payload.boardId, revision: 1, elements: payload.boardId === 'replacement' ? [] : [structuredClone(fixture)], files: {}, selectedIds: [] };
    };
    const controller = new AbortController();
    const props = { sessionId: 'embed-rejection-session', rpc, signal: controller.signal };
    await act(async () => { renderer = create(React.createElement(Whiteboard, props), { createNodeMock: () => new Node() }); });
    assert.equal(reads, 1, 'successful get must establish the real BoardSync baseline');
    assert.deepEqual(h.elements, [fixture]);
    const editor = () => renderer.root.findByType('native-editor');
    const draft = { ...fixture, id: 'unsaved-draft', x: 120 };
    act(() => {
      editor().props.onPointerDown();
      h.undo.push(structuredClone(h.elements));
      h.elements = [...h.elements, draft];
      h.appState.selectedElementIds = { [draft.id]: true };
      rerender();
    });
    const accepted = structuredClone(h.elements);
    const undoBefore = structuredClone(h.undo);
    const clearsBefore = h.historyClears;
    assert.equal(writes, 0, 'fixture must contain an accepted but unsaved local draft');
    assert.ok([...storage.values()].some(value => JSON.parse(value).local.elements.some(element => element.id === draft.id)), 'actual BoardSync must observe draft before rejection');
    const embed = { id: 'unsupported-webpage', type: 'embeddable', x: 20, y: 20, width: 0, height: 0, isDeleted: false };
    const callbacksBefore = h.callbacks;
    assert.doesNotThrow(() => act(() => {
      h.elements = [...h.elements, embed];
      Object.assign(h.appState, { activeTool: { type: 'embeddable', customType: null, locked: false, lastActiveTool: null }, newElement: embed, selectedElementIds: { [embed.id]: true } });
      rerender();
    }), 'native componentDidUpdate -> onChange -> warning must settle before rollback microtasks; otherwise React unmounts the whiteboard');
    assert.ok(h.callbacks - callbacksBefore < 12, 'rejection must not produce unbounded synchronous native callbacks');
    assert.equal(h.unmounts, 0);
    const queuedBeforeRepeats = pendingMicrotasks.length;
    for (let i = 0; i < 5; i++) act(() => rerender());
    assert.equal(pendingMicrotasks.length, queuedBeforeRepeats, 'repeat native notifications before repair must not enqueue duplicate repairs');
    assert.ok(pendingMicrotasks.length <= 1, 'one rejected placement must schedule at most one repair');
    const drainRepairs = () => {
      let drained = 0;
      while (pendingMicrotasks.length) {
        assert.ok(++drained <= 4, 'rollback must not continually reschedule itself');
        act(() => pendingMicrotasks.shift()());
      }
    };
    drainRepairs();
    assert.deepEqual(h.elements, accepted, 'rollback retains the accepted unsaved drawing, not just remote baseline');
    assert.deepEqual(h.appState.selectedElementIds, { [draft.id]: true });
    assert.equal(h.appState.activeTool.type, 'selection');
    assert.equal(h.appState.newElement, null, 'removed embed must not remain the native in-progress element');
    assert.deepEqual(h.undo, undoBefore, 'rejection must not erase prior native undo entries');
    assert.equal(h.historyClears, clearsBefore);
    assert.equal(h.mounts, 1);
    assert.equal(h.unmounts, 0);
    assert.equal(anticipatedReactErrors.length, 0);
    const ordinary = { ...fixture, id: 'after-rejection', y: 150 };
    act(() => {
      h.undo.push(structuredClone(h.elements));
      h.elements = [...h.elements, ordinary];
      h.appState.selectedElementIds = { [ordinary.id]: true };
      rerender();
    });
    assert.ok([...storage.values()].some(value => JSON.parse(value).local.elements.some(element => element.id === ordinary.id)), 'subsequent ordinary editing still reaches real sync/recovery');
    act(() => { h.elements = h.undo.pop(); h.appState.selectedElementIds = { [draft.id]: true }; rerender(); });
    assert.deepEqual(h.elements, accepted, 'ordinary edit remains undoable after rejected placement');
    assert.equal(h.mounts, 1);

    for (const placement of [
      { name: 'drag-sized embed', element: { ...embed, id: 'drag-embed', width: 320, height: 180 } },
      { name: 'tool-only activation', element: null },
    ]) {
      const before = { scene: structuredClone(h.elements), undo: structuredClone(h.undo), clears: h.historyClears, callbacks: h.callbacks };
      act(() => {
        const element = placement.element;
        if (element) h.elements = [...h.elements, element];
        Object.assign(h.appState, { activeTool: { type: 'embeddable', customType: null, locked: false, lastActiveTool: null }, newElement: element, resizingElement: element, multiElement: element, activeEmbeddable: element && { element, state: 'active' }, selectedElementIds: element ? { [element.id]: true } : h.appState.selectedElementIds });
        rerender();
      });
      for (let i = 0; i < 3; i++) act(() => rerender());
      assert.ok(h.callbacks - before.callbacks < 12, `${placement.name} must settle before repair`);
      assert.equal(pendingMicrotasks.length, 1, `${placement.name} must enqueue one repair even without a rejected scene element`);
      drainRepairs();
      assert.deepEqual(h.elements, before.scene, `${placement.name} preserves supported draft`);
      assert.deepEqual(h.undo, before.undo, `${placement.name} preserves native undo entries`);
      assert.equal(h.historyClears, before.clears);
      for (const field of ['newElement', 'resizingElement', 'multiElement', 'activeEmbeddable']) assert.equal(h.appState[field], null, `${placement.name} clears ${field}`);
      assert.deepEqual(h.appState.activeTool, { type: 'selection', customType: null, locked: false, lastActiveTool: null });
    }

    // Queue one old-owner rejection, then replace BoardSync by changing boards
    // before that microtask can run. Real onScene setup may touch the editor;
    // the stale callback itself must not touch the new board or clear its guard.
    act(() => {
      h.elements = [...h.elements, { ...embed, id: 'old-owner-embed' }];
      h.appState.activeTool = { type: 'embeddable', customType: null, locked: false, lastActiveTool: null };
      h.appState.newElement = h.elements.at(-1);
      rerender();
    });
    assert.equal(pendingMicrotasks.length, 1);
    const staleRepair = pendingMicrotasks.shift();
    // A tool reset is independent of the queued scene rollback. It keeps the
    // new board's initialization from itself generating another embed warning.
    h.appState.activeTool = { type: 'selection', customType: null, locked: false, lastActiveTool: null };
    h.appState.newElement = null;
    h.appState.selectedElementIds = {};
    await act(async () => renderer.update(React.createElement(Whiteboard, { ...props, boardId: 'replacement' })));
    assert.equal(reads, 2, 'changing board creates a fresh sync owner');
    assert.deepEqual(h.elements, [], 'replacement fixture is a truly empty board');
    const replacementBefore = { changes: h.changes.length, callbacks: h.callbacks, state: structuredClone(h.appState), clears: h.historyClears };
    act(() => staleRepair());
    assert.equal(h.changes.length, replacementBefore.changes, 'old-owner repair must not update replacement board');
    assert.equal(h.callbacks, replacementBefore.callbacks);
    assert.deepEqual(h.appState, replacementBefore.state);
    assert.equal(h.historyClears, replacementBefore.clears);
    assert.equal(pendingMicrotasks.length, 0);

    // The old callback must not leave rejection latched for the new owner.
    act(() => { h.api.setActiveTool({ type: 'embeddable' }); });
    assert.equal(pendingMicrotasks.length, 1, 'tool activation with NO scene elements must still be rejected');
    drainRepairs();
    assert.deepEqual(h.elements, []);
    assert.equal(h.appState.activeTool.type, 'selection');

    // Closing an owner (signal abort) also invalidates its queued repair. Abort
    // may synchronously close native menus; snapshot AFTER those intentional UI
    // updates so only an illicit stale repair is counted.
    act(() => { h.api.setActiveTool({ type: 'embeddable' }); });
    assert.equal(pendingMicrotasks.length, 1);
    act(() => controller.abort());
    const closedBefore = { changes: h.changes.length, callbacks: h.callbacks, state: structuredClone(h.appState), clears: h.historyClears };
    drainRepairs();
    assert.equal(h.changes.length, closedBefore.changes, 'disposed-owner repair must not touch the closed editor');
    assert.equal(h.callbacks, closedBefore.callbacks);
    assert.deepEqual(h.appState, closedBefore.state);
    assert.equal(h.historyClears, closedBefore.clears);
    assert.equal(h.mounts, 1);
    assert.equal(h.unmounts, 0, 'board owner changes must not require remounting native editor');
    assert.equal(anticipatedReactErrors.length, 0);
  } finally {
    // A red baseline can unmount the tree before queued repairs. Do not execute
    // repairs against an unmounted test fixture; restore every patched global.
    pendingMicrotasks.length = 0;
    try { if (renderer) act(() => renderer.unmount()); }
    finally {
      console.error = originalConsoleError;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      await unlink(output).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
});
