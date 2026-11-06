import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import React from 'react';
import { create, act } from 'react-test-renderer';

// Component lifecycle tests with a native-editor stub, not a browser/layout test.
test('sidebar expansion and zoom keep one editor and one sync session', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = join(root, 'node_modules', `.whiteboard-ui-${process.pid}.mjs`);
  const { writeFile, unlink } = await import('node:fs/promises');
  class Node {
    children = []; parentNode = null; className = '';
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
    contains(child) { return this === child || this.children.some(n => n.contains?.(child)); }
    focus() { globalThis.document.activeElement = this; }
  }
  const previous = Object.fromEntries(['document', 'window', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame'].map(k => [k, globalThis[k]]));
  const body = new Node();
  globalThis.document = { body, activeElement: null, createElement: () => new Node() };
  globalThis.window = new EventTarget();
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  const state = { zoom: { value: 1 }, width: 400, height: 600, scrollX: 20, scrollY: -30, selectedElementIds: {} };
  let mounts = 0, unmounts = 0, reads = 0, saves = 0, refreshes = 0, historyClears = 0;
  const api = { getAppState: () => state, getSceneElements: () => [], getFiles: () => ({}), addFiles() {}, history: { clear() { historyClears++; } }, refresh() { refreshes++; }, scrollToContent() {}, updateScene(change) { Object.assign(state, change.appState); } };
  globalThis.__wbUi = { api, mount: () => mounts++, unmount: () => unmounts++ };
  let renderer;
  try {
    const result = await build({ entryPoints: [join(root, 'src/Whiteboard.jsx')], bundle: true, write: false, format: 'esm', platform: 'node', external: ['react'], plugins: [{ name: 'native-ui-stubs', setup(build) {
      build.onResolve({ filter: /^(@excalidraw\/excalidraw|react-dom)$/ }, args => ({ path: args.path, namespace: 'ui-stub' }));
      build.onLoad({ filter: /.*/, namespace: 'ui-stub' }, args => ({ loader: 'js', contents: args.path === 'react-dom' ? `import React from 'react'; export const createPortal = (children, container) => React.createElement('portal', {container}, children);` : `import React from 'react'; export function Excalidraw(props) { React.useEffect(() => { globalThis.__wbUi.mount(); props.excalidrawAPI(globalThis.__wbUi.api); return () => globalThis.__wbUi.unmount(); }, []); return React.createElement('native-editor', props); } export function MainMenu({children}) {return children;} MainMenu.DefaultItems = {ClearCanvas: () => null, ToggleTheme: () => null}; export const CaptureUpdateAction = {NEVER:'NEVER',IMMEDIATELY:'IMMEDIATELY'}; export const restoreElements = elements => elements; export const exportToBlob = () => null; export const exportToSvg = () => null; export const serializeAsJSON = () => '';` }));
    } }] });
    await writeFile(output, result.outputFiles[0].text);
    const { Whiteboard } = await import(pathToFileURL(output).href);
    const rpc = async method => { if (method === 'save') saves++; else reads++; return { sessionId: 'ui-session', revision: 0, elements: [], files: {}, selectedIds: [] }; };
    const controller = new AbortController();
    const props = { sessionId: 'ui-session', rpc, visible: true, signal: controller.signal };
    await act(async () => { renderer = create(React.createElement(Whiteboard, props), { createNodeMock: () => new Node() }); });
    const button = label => renderer.root.findAllByType('button').find(node => node.props['aria-label'] === label);
    assert.ok(button('大屏编辑'), 'narrow sidebar must expose a named large-screen entry');
    assert.ok(button('放大画布'), 'zoom-in must not be hidden in the native sidebar toolbar');
    assert.ok(button('缩小画布'));
    const portal = renderer.root.findByType('portal').props.container;
    const inlineParent = portal.parentNode;
    assert.notEqual(inlineParent, body);
    const initialReads = reads, initialHistoryClears = historyClears;
    await act(async () => button('大屏编辑').props.onClick());
    assert.equal(portal.parentNode, body, 'expanded viewport must escape the clipped sidebar');
    assert.ok(button('返回侧栏'));
    await act(async () => button('放大画布').props.onClick());
    assert.ok(state.zoom.value > 1);
    await act(async () => button('重置缩放为 100%').props.onClick());
    assert.equal(state.zoom.value, 1);
    await act(async () => button('返回侧栏').props.onClick());
    assert.equal(portal.parentNode, inlineParent);
    assert.equal(mounts, 1, 'expansion must not remount editor or reset undo history');
    assert.equal(unmounts, 0);
    assert.equal(reads, initialReads, 'moving the editor must not reopen the sync session');
    assert.equal(saves, 0, 'view controls must not write the shared drawing');
    assert.equal(historyClears, initialHistoryClears, 'zoom and expansion must retain undo history');
    await act(async () => button('大屏编辑').props.onClick());
    let nativeEscapes = 0;
    const escape = () => {
      const event = { key: 'Escape', defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
      renderer.root.findByType('section').props.onKeyDownCapture(event);
      // Simulate the real native editor consuming every Escape in bubble phase.
      if (!event.stopped) { nativeEscapes++; event.preventDefault(); event.stopPropagation(); }
    };
    state.editingTextElement = { id: 'typing' };
    await act(async () => escape());
    assert.equal(portal.parentNode, body, 'text editing consumes Escape before leaving large-screen mode');
    state.editingTextElement = null;
    state.openPopup = 'elementStroke';
    await act(async () => escape());
    assert.equal(portal.parentNode, body, 'native popup keeps Escape priority');
    state.openPopup = null;
    state.selectedElementIds = { selected: true };
    await act(async () => escape());
    assert.equal(portal.parentNode, body, 'first Escape should allow native deselection');
    state.selectedElementIds = {};
    await act(async () => escape());
    assert.equal(nativeEscapes, 3);
    assert.equal(portal.parentNode, inlineParent);
    await act(async () => button('大屏编辑').props.onClick());
    await act(async () => renderer.update(React.createElement(Whiteboard, { ...props, visible: false })));
    assert.equal(portal.parentNode, inlineParent, 'hidden session must never leave a fullscreen overlay');
    await act(async () => renderer.update(React.createElement(Whiteboard, props)));
    await act(async () => button('大屏编辑').props.onClick());
    await act(async () => controller.abort());
    assert.equal(portal.parentNode, inlineParent, 'closed occurrence must release its overlay');
    assert.ok(refreshes > 0);
    await act(async () => renderer.update(React.createElement(Whiteboard, { ...props, key: 'second', sessionId: 'second', signal: new AbortController().signal })));
    const secondPortal = renderer.root.findByType('portal').props.container;
    assert.notEqual(secondPortal, portal);
    assert.equal(portal.parentNode, null, 'switching sessions removes the previous portal host');
    assert.equal(mounts, 2);
    assert.equal(unmounts, 1);
    const alreadyClosed = new AbortController(); alreadyClosed.abort();
    await act(async () => renderer.update(React.createElement(Whiteboard, { ...props, key: 'closed', signal: alreadyClosed.signal })));
    await act(async () => button('大屏编辑').props.onClick());
    assert.equal(body.children.length, 0, 'an already-aborted tab cannot create an overlay');
  } finally {
    await act(async () => renderer?.unmount());
    assert.equal(body.children.length, 0);
    delete globalThis.__wbUi;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    assert.ok(output.startsWith(join(root, 'node_modules') + '/'));
    await unlink(output).catch(() => {});
  }
});
