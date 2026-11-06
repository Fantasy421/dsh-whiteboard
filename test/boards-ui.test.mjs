import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile, unlink } from 'node:fs/promises';
import React from 'react';
import { act, create } from 'react-test-renderer';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'node_modules', `.boards-ui-${process.pid}.mjs`);
let Boards;
test.before(async () => {
  const result = await build({ entryPoints: [join(root, 'src/Boards.jsx')], bundle: true, write: false, format: 'esm', platform: 'node', external: ['react', 'react-dom'], plugins: [{ name: 'editor-stub', setup(builder) {
    builder.onResolve({ filter: /\/Whiteboard\.jsx$/ }, () => ({ path: 'editor', namespace: 'boards-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'boards-test' }, () => ({ loader: 'js', contents: `
      import React from 'react';
      export function Whiteboard(props) {
        const state = globalThis.__boardsTest;
        const [instance] = React.useState(() => ++state.instance);
        React.useEffect(() => {
          state.mounts.push({sessionId:props.sessionId, boardId:props.boardId, instance});
          const unregister = props.registerLeaveGuard(props.boardId, () => state.guard(props.boardId));
          return () => { unregister(); state.unmounts.push(instance); };
        }, []);
        return React.createElement('mock-editor', {...props, instance}, props.navigation, props.navigationNotice);
      }
    ` }));
  } }] });
  await writeFile(output, result.outputFiles[0].text);
  ({ Boards } = await import(pathToFileURL(output).href));
});
test.after(async () => {
  assert.ok(output.startsWith(join(root, 'node_modules') + '/'));
  await unlink(output);
});

const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const makeCatalog = (sessionId = 'session', boards = [{ id: 'default', name: '默认白板' }], revision = 0, activeBoardId = boards[0].id) => ({ sessionId, revision, activeBoardId, boards });
const text = node => typeof node === 'string' ? node : (node.children || []).map(text).join('');

async function harness(t, { catalog = makeCatalog(), intercept = null, guard = () => true, openManagement = true } = {}) {
  let server = clone(catalog), created = 0, renderer;
  const calls = [], intervals = new Set(), confirmations = [];
  const old = { window: globalThis.window, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, state: globalThis.__boardsTest };
  globalThis.window = Object.assign(new EventTarget(), { confirm: message => { confirmations.push(message); return true; } });
  globalThis.setInterval = (fn, delay) => { assert.equal(delay, 3000); intervals.add(fn); return fn; };
  globalThis.clearInterval = fn => intervals.delete(fn);
  const state = globalThis.__boardsTest = { guard, instance: 0, mounts: [], unmounts: [] };
  const rpc = async (method, payload, signal) => {
    const call = { method, payload: clone(payload), signal };
    calls.push(call);
    if (intercept) {
      const outcome = intercept(call, server);
      if (outcome !== undefined) return outcome;
    }
    if (method === 'list') return clone(server);
    assert.equal(payload.baseRevision, server.revision, 'every mutation must use the exact latest catalog revision');
    const next = clone(server);
    next.revision++;
    if (payload.action === 'create') {
      const board = { id: `new-${++created}`, name: payload.name };
      next.boards.push(board); next.activeBoardId = board.id;
    } else if (payload.action === 'rename') next.boards.find(board => board.id === payload.boardId).name = payload.name;
    else if (payload.action === 'activate') next.activeBoardId = payload.boardId;
    else if (payload.action === 'delete') {
      next.boards = next.boards.filter(board => board.id !== payload.boardId);
      if (next.activeBoardId === payload.boardId) next.activeBoardId = next.boards[0].id;
    } else assert.fail(`unexpected action ${payload.action}`);
    server = next;
    return clone(next);
  };
  const controller = new AbortController();
  let props = { sessionId: catalog.sessionId, rpc, signal: controller.signal, visible: true };
  await act(async () => { renderer = create(React.createElement(Boards, props)); });
  t.after(async () => {
    await act(async () => renderer.unmount());
    assert.equal(intervals.size, 0);
    for (const key of ['window', 'setInterval', 'clearInterval']) {
      if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key];
    }
    if (old.state === undefined) delete globalThis.__boardsTest; else globalThis.__boardsTest = old.state;
  });
  const api = {
    state, calls, controller, confirmations,
    root: () => renderer.root,
    editor: () => renderer.root.findByType('mock-editor'),
    byLabel: label => renderer.root.find(node => node.props['aria-label'] === label),
    button: label => renderer.root.findAllByType('button').find(node => node.props['aria-label'] === label || text(node) === label),
    manager: () => renderer.root.findAllByProps({ 'data-dsh-wb-menu': 'boards' })[0],
    openManager: async () => { const menu = api.manager(); if (menu && !menu.props.open) await act(async () => menu.findByType('summary').props.onClick({ preventDefault() {} })); },
    closeManager: async () => { const menu = api.manager(); if (menu?.props.open) await act(async () => menu.findByType('summary').props.onClick({ preventDefault() {} })); },
    click: async label => { if (!api.button(label)) await api.openManager(); const button = api.button(label); assert.ok(button, `missing button ${label}`); assert.equal(Boolean(button.props.disabled), false, `${label} disabled`); await act(async () => button.props.onClick()); if (openManagement) await api.openManager(); },
    input: async (label, value) => { if (!renderer.root.findAll(node => node.props['aria-label'] === label).length) await api.openManager(); await act(async () => api.byLabel(label).props.onChange({ target: { value } })); },
    select: async id => { await api.input('切换白板', id); if (openManagement) await api.openManager(); },
    submit: async () => { await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} })); if (openManagement) await api.openManager(); },
    named: async (action, name) => { await api.click(action); await api.input('白板名称', name); await api.submit(); },
    tick: async () => act(async () => { for (const callback of intervals) callback(); }),
    update: async next => { props = { ...props, ...next }; await act(async () => renderer.update(React.createElement(Boards, props))); },
    server: () => server,
    setServer: next => { server = clone(next); },
    content: () => text(renderer.toJSON() || {}),
    actions: () => calls.filter(call => call.method === 'manage'),
  };
  if (api.manager()) {
    assert.equal(api.manager().props.open, false, 'new editor occurrences must start with management collapsed');
    assert.equal(renderer.root.findAllByType('input').length, 0, 'closed management must not mount focusable form/search controls');
    if (openManagement) await api.openManager();
  }
  return api;
}

test('legacy default loads only after validation; create, rename, select and delete use isolated editors', async t => {
  const h = await harness(t);
  assert.equal(h.editor().props.boardId, 'default');
  assert.equal(h.editor().props.boardName, '默认白板');
  assert.equal(h.button('删除白板').props.disabled, true);
  const first = h.editor().props.instance;
  await h.named('新建白板', '  方案 A  ');
  assert.equal(h.editor().props.boardId, 'new-1');
  assert.equal(h.actions()[0].payload.name, '方案 A');
  assert.notEqual(h.editor().props.instance, first, 'board switch must remount native editor/undo ownership');
  const second = h.editor().props.instance;
  await h.named('重命名白板', '最终方案');
  assert.equal(h.editor().props.boardName, '最终方案');
  assert.equal(h.editor().props.instance, second, 'rename must not remount or lose dirty scene');
  await h.select('default');
  assert.equal(h.editor().props.boardId, 'default');
  assert.notEqual(h.editor().props.instance, first, 'returning to a board starts a fresh editor and undo stack');
  await h.select('new-1');
  await h.click('删除白板');
  assert.ok(h.confirmations[0].includes('最终方案'));
  assert.equal(h.editor().props.boardId, 'default');
  assert.equal(h.button('删除白板').props.disabled, true);
  assert.deepEqual(h.actions().map(call => call.payload.action), ['create', 'rename', 'activate', 'activate', 'delete']);
  assert.deepEqual(h.actions().map(call => call.payload.baseRevision), [0, 1, 2, 3, 4]);
});

test('search retains selected choice and bounded previous/next navigate in catalog order', async t => {
  const h = await harness(t, { catalog: makeCatalog('session', [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }]) });
  assert.equal(h.button('上一张白板').props.disabled, true);
  assert.ok(h.button('下一张白板').props.title.includes('2/3：Beta'));
  await h.input('搜索白板', 'Gamma');
  assert.deepEqual(h.root().findAllByType('option').map(node => node.props.value), ['a', 'c']);
  assert.equal(h.byLabel('切换白板').props.value, 'a');
  assert.equal(h.actions().length, 0, 'search itself must never switch board');
  await h.click('下一张白板');
  assert.equal(h.editor().props.boardId, 'b', 'quick jump uses full catalog rather than filtered subset');
  await h.click('下一张白板');
  assert.equal(h.editor().props.boardId, 'c');
  assert.equal(h.button('下一张白板').props.disabled, true);
  await h.click('上一张白板');
  assert.equal(h.editor().props.boardId, 'b');
  await h.input('搜索白板', 'a');
  assert.deepEqual(h.root().findAllByType('option').map(node => node.props.value), ['a', 'b', 'c']);
});

test('dirty guard blocks switch, create and active delete; rename and read-only refresh remain allowed', async t => {
  let guards = 0;
  const h = await harness(t, { catalog: makeCatalog('session', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]), guard: () => { guards++; return false; } });
  const instance = h.editor().props.instance;
  await h.select('b');
  await h.named('新建白板', 'blocked');
  await h.click('取消');
  await h.click('删除白板');
  assert.equal(guards, 3);
  assert.equal(h.actions().length, 0);
  assert.equal(h.editor().props.instance, instance);
  assert.ok(h.content().includes('有未保存或冲突修改，请先保存或导出后处理'));
  await h.named('重命名白板', 'Dirty but renamed');
  await h.click('刷新列表');
  assert.equal(guards, 3, 'read/rename cannot depend on leave approval');
  assert.equal(h.editor().props.instance, instance);
  assert.equal(h.editor().props.boardName, 'Dirty but renamed');
});

test('pending guard exposes busy UI and serializes duplicate management attempts', async t => {
  const wait = deferred();
  const h = await harness(t, { catalog: makeCatalog('session', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]), guard: () => wait.promise });
  let operation;
  await act(async () => { operation = h.byLabel('切换白板').props.onChange({ target: { value: 'b' } }); });
  assert.equal(h.byLabel('白板导航').props['aria-busy'], true);
  assert.equal(h.editor().props.blocked, true, 'native canvas is inert while guard/catalog operation is pending');
  assert.equal(h.byLabel('切换白板').props.disabled, true);
  assert.equal(h.button('新建白板').props.disabled, true);
  assert.equal(h.actions().length, 0, 'guard completes before catalog mutation');
  await act(async () => h.byLabel('切换白板').props.onChange({ target: { value: 'b' } }));
  assert.equal(h.actions().length, 0);
  await act(async () => { wait.resolve(true); await operation; });
  assert.equal(h.actions().length, 1);
  assert.equal(h.editor().props.boardId, 'b');
});

test('catalog conflicts and unknown write outcomes reconcile by fresh list without retries or scene swap', async t => {
  let fail = true;
  const h = await harness(t, { catalog: makeCatalog('session', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]), intercept: call => {
    if (call.method === 'manage' && fail) throw Object.assign(new Error('conflict'), { code: 'whiteboard/catalog-conflict', details: { catalog: makeCatalog('session', [{ id: 'evil', name: 'not applied' }]) } });
  } });
  h.setServer({ ...h.server(), revision: 8, activeBoardId: 'b' });
  const instance = h.editor().props.instance;
  await h.select('b');
  assert.equal(h.actions().length, 1);
  assert.equal(h.calls.filter(call => call.method === 'list').length, 2);
  assert.equal(h.editor().props.instance, instance);
  assert.equal(h.editor().props.boardId, 'a');
  assert.ok(h.content().includes('已被其他窗口修改'));
  fail = false;
  await h.named('重命名白板', 'latest revision');
  assert.equal(h.actions().at(-1).payload.baseRevision, 8);

  // A write may have reached the server even though its reply was lost.
  fail = true;
  const before = h.actions().length;
  await h.named('新建白板', 'No duplicate');
  assert.equal(h.actions().length, before + 1);
  assert.equal(h.editor().props.boardId, 'a');
});

test('unknown outcome create finds server board on reconcile but requires explicit guarded choice', async t => {
  let h;
  h = await harness(t, { intercept: call => {
    if (call.method === 'manage') {
      h.setServer(makeCatalog('session', [{ id: 'default', name: '默认白板' }, { id: 'accepted', name: call.payload.name }], 1, 'accepted'));
      throw new Error('request timed out');
    }
  } });
  await h.named('新建白板', 'server accepted');
  assert.equal(h.actions().length, 1);
  assert.equal(h.editor().props.boardId, 'default');
  assert.ok(h.root().findAllByType('option').some(node => node.props.value === 'accepted'));
  assert.ok(h.content().includes('操作结果未知'));
  assert.equal(h.root().findAllByType('form').length, 0);
});

test('poll does not yank pinned selection; remotely deleted selection retains draft and guard', async t => {
  const h = await harness(t, { catalog: makeCatalog('session', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]), guard: () => false });
  const instance = h.editor().props.instance;
  h.setServer({ ...h.server(), revision: 1, activeBoardId: 'b' });
  await h.tick();
  assert.equal(h.editor().props.boardId, 'a');
  assert.equal(h.editor().props.instance, instance);
  h.setServer(makeCatalog('session', [{ id: 'b', name: 'B' }], 2));
  await h.tick();
  assert.equal(h.editor().props.boardId, 'a');
  assert.equal(h.editor().props.instance, instance);
  assert.ok(h.content().includes('当前白板已被删除'));
  await h.select('b');
  assert.equal(h.actions().length, 0);
  assert.equal(h.editor().props.instance, instance);
  h.state.guard = () => true;
  await h.select('b');
  assert.equal(h.editor().props.boardId, 'b');
});

test('overlapping polls are skipped; a stale poll cannot overwrite confirmed mutation catalog', async t => {
  const wait = deferred();
  let delay = false;
  const h = await harness(t, { intercept: call => { if (call.method === 'list' && delay) return wait.promise; } });
  delay = true;
  await h.tick();
  await h.tick();
  assert.equal(h.calls.filter(call => call.method === 'list').length, 2);
  await h.named('新建白板', 'new confirmed');
  assert.equal(h.editor().props.boardId, 'new-1');
  await act(async () => { wait.resolve(makeCatalog()); });
  assert.equal(h.editor().props.boardId, 'new-1');
  assert.equal(h.root().findAllByType('option').length, 2);
  await h.named('重命名白板', 'revision two');
  assert.equal(h.actions().at(-1).payload.baseRevision, 1);
});

test('initial failure/empty catalog never mounts fallback; retry validates preferred board', async t => {
  let initial = true;
  const h = await harness(t, { intercept: call => {
    if (call.method === 'list' && initial) return makeCatalog('session', [], 0, 'default');
  } });
  assert.equal(h.root().findAllByType('mock-editor').length, 0);
  assert.ok(h.content().includes('白板目录无效'));
  initial = false;
  h.setServer(makeCatalog('session', [{ id: 'preferred', name: 'Preferred' }]));
  await h.click('重试');
  assert.equal(h.editor().props.boardId, 'preferred');
});

test('close aborts owned requests and ignores late initial/mutation/guard replies', async t => {
  const wait = deferred();
  const h = await harness(t, { intercept: call => call.method === 'list' ? wait.promise : undefined });
  assert.equal(h.root().findAllByType('mock-editor').length, 0);
  const requestSignal = h.calls[0].signal;
  await act(async () => h.controller.abort());
  assert.equal(requestSignal.aborted, true);
  await act(async () => wait.resolve(makeCatalog()));
  assert.equal(h.root().findAllByType('mock-editor').length, 0);
});

test('session/occurrence change clears old ownership and late response cannot become new catalog', async t => {
  const oldWrite = deferred();
  const h = await harness(t, { intercept: call => call.method === 'manage' ? oldWrite.promise : undefined });
  let operation;
  await h.click('新建白板');
  await h.input('白板名称', 'old write');
  await act(async () => { operation = h.root().findByType('form').props.onSubmit({ preventDefault() {} }); });
  const oldSignal = h.actions()[0].signal;
  h.setServer(makeCatalog('second', [{ id: 'other', name: 'Other session' }]));
  await h.update({ sessionId: 'second', signal: new AbortController().signal });
  assert.equal(oldSignal.aborted, true);
  assert.equal(h.editor().props.sessionId, 'second');
  assert.equal(h.editor().props.boardId, 'other');
  await act(async () => { oldWrite.resolve(makeCatalog('session', [{ id: 'late', name: 'Late' }])); await operation; });
  assert.equal(h.editor().props.boardId, 'other');
  const instance = h.editor().props.instance;
  await h.update({ signal: new AbortController().signal });
  assert.notEqual(h.editor().props.instance, instance, 'a new owner for the same session must reopen a validated editor');
});

test('hidden view pauses polling and resumed view preserves local selection', async t => {
  const h = await harness(t);
  const instance = h.editor().props.instance;
  await h.update({ visible: false });
  const before = h.calls.length;
  await h.tick();
  assert.equal(h.calls.length, before);
  await h.update({ visible: true });
  await h.tick();
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.editor().props.instance, instance);
});

test('a non-cooperating timed-out write releases pending gate, refreshes, and never retries', async t => {
  const never = deferred();
  const h = await harness(t, { intercept: call => call.method === 'manage' ? never.promise : undefined });
  const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 10000) return nativeSetTimeout(callback, delay, ...args);
    const handle = {};
    timers.set(handle, callback);
    return handle;
  };
  globalThis.clearTimeout = handle => timers.delete(handle) || nativeClearTimeout(handle);
  try {
    await h.click('新建白板');
    await h.input('白板名称', 'Uncertain');
    await act(async () => { h.root().findByType('form').props.onSubmit({ preventDefault() {} }); });
    assert.equal(h.actions().length, 1);
    const pendingSignal = h.actions()[0].signal;
    assert.equal(pendingSignal.aborted, false);
    await act(async () => { for (const callback of [...timers.values()]) callback(); });
    assert.equal(pendingSignal.aborted, true);
    assert.equal(h.editor().props.blocked, false);
    assert.equal(h.editor().props.boardId, 'default');
    assert.equal(h.actions().length, 1);
    assert.equal(h.calls.filter(call => call.method === 'list').length, 2);
    assert.ok(h.content().includes('操作结果未知'));
    await act(async () => never.resolve(makeCatalog('session', [{ id: 'late', name: 'Late timeout result' }])));
    assert.equal(h.editor().props.boardId, 'default');
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
});

test('post-RPC guard detects delayed editor changes and preserves draft after successful catalog write', async t => {
  let checks = 0;
  const h = await harness(t, { guard: () => ++checks === 1 });
  const instance = h.editor().props.instance;
  await h.named('新建白板', 'Created but not opened');
  assert.equal(checks, 2);
  assert.equal(h.actions().length, 1);
  assert.equal(h.server().activeBoardId, 'new-1');
  assert.equal(h.editor().props.boardId, 'default');
  assert.equal(h.editor().props.instance, instance);
  assert.equal(h.editor().props.blocked, false);
  assert.ok(h.content().includes('目录操作已完成，当前草稿仍保留'));
});

test('deleted draft escape requires a distinct explicit export/discard confirmation', async t => {
  const h = await harness(t, { catalog: makeCatalog('session', [{ id: 'a', name: 'Lost draft' }, { id: 'b', name: 'B' }]), guard: () => false });
  assert.equal(h.button('关闭已删除白板'), undefined, 'normal dirty board must have no bypass');
  h.setServer(makeCatalog('session', [{ id: 'b', name: 'B' }], 1));
  await h.tick();
  window.confirm = () => false;
  await h.click('关闭已删除白板');
  assert.equal(h.editor().props.boardId, 'a');
  let message;
  window.confirm = value => { message = value; return true; };
  await h.click('关闭已删除白板');
  assert.ok(message.includes('请先导出未保存内容'));
  assert.ok(message.includes('浏览器恢复备份不保证可用'));
  assert.ok(message.includes('Lost draft'));
  assert.equal(h.editor().props.boardId, 'b');
  assert.equal(h.actions().length, 0, 'cannot write/recreate a remotely deleted board');
});

test('owner close during leave guard cannot issue a subsequent catalog mutation', async t => {
  const wait = deferred();
  const h = await harness(t, { guard: () => wait.promise });
  await h.click('新建白板');
  await h.input('白板名称', 'Never submitted');
  await act(async () => { h.root().findByType('form').props.onSubmit({ preventDefault() {} }); });
  await act(async () => h.controller.abort());
  await act(async () => wait.resolve(true));
  assert.equal(h.actions().length, 0);
  assert.equal(h.root().findAllByType('mock-editor').length, 0);
});

test('name form trims and enforces 80 characters before any write', async t => {
  const h = await harness(t);
  await h.click('新建白板');
  assert.equal(h.button('确认').props.disabled, true);
  await h.input('白板名称', '   ');
  await h.submit();
  await h.input('白板名称', 'x'.repeat(81));
  assert.equal(h.button('确认').props.disabled, true);
  await h.submit();
  assert.equal(h.actions().length, 0);
  await h.input('白板名称', ` ${'x'.repeat(80)} `);
  await h.submit();
  assert.equal(h.actions()[0].payload.name.length, 80);
});


test('management starts collapsed and only mounts forms on demand without replacing the editor', async t => {
  const h = await harness(t, { openManagement: false });
  const instance = h.editor().props.instance;
  assert.equal(h.manager().props.open, false);
  assert.equal(h.button('新建白板'), undefined);
  assert.equal(h.root().findAllByType('input').length, 0);
  await h.openManager();
  await h.click('新建白板');
  assert.equal(h.byLabel('白板名称').props.autoFocus, true);
  await h.closeManager();
  assert.equal(h.root().findAllByType('form').length, 0);
  assert.equal(h.root().findAllByType('input').length, 0);
  await h.openManager();
  assert.equal(h.root().findAllByType('form').length, 0, 'cancelled form must not resurrect/steal focus');
  assert.equal(h.editor().props.instance, instance);
  await act(async () => window.dispatchEvent(new Event('pointerdown')));
  assert.equal(h.manager().props.open, false, 'outside interaction closes the menu');
  await h.openManager();
  await h.update({ visible: false });
  assert.equal(h.manager().props.open, false);
  await h.update({ visible: true });
  assert.equal(h.manager().props.open, false);
  assert.equal(h.editor().props.instance, instance, 'hide/disclosure changes retain draft ownership');
  assert.equal(h.actions().length, 0, 'opening/collapsing is not a catalog mutation');
});

test('missing-draft and save-guard warnings remain visible while management is collapsed', async t => {
  const h = await harness(t, { openManagement: false, catalog: makeCatalog('session', [{id:'a',name:'A'},{id:'b',name:'B'}]), guard: () => false });
  await h.select('b');
  await h.closeManager();
  assert.ok(h.content().includes('未保存'));
  assert.equal(h.editor().props.boardId, 'a');
  h.setServer(makeCatalog('session', [{id:'b',name:'B'}], 1));
  await h.tick();
  assert.equal(h.manager().props.open, false);
  assert.ok(h.content().includes('当前白板已被删除'));
  assert.ok(h.button('关闭已删除白板'), 'export/discard escape must not hide inside management');
  assert.equal(h.editor().props.boardId, 'a', 'a collapsed menu cannot force-switch a deleted draft');
});
