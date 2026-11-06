import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { zoomAtCenter, MIN_ZOOM, MAX_ZOOM } from './viewport.mjs';
import { Excalidraw, MainMenu, CaptureUpdateAction, restoreElements, newElementWith, exportToBlob, exportToSvg, serializeAsJSON } from '@excalidraw/excalidraw';
import { LINE_STYLES, styleLinearElement, linearPathMidpoint } from './linear.mjs';
import { BoardSync } from './sync.mjs';
import { safeNativeInput } from './scene.mjs';
import { recoveryFor } from './recovery.mjs';
const LINE_LABELS = { straight: '直线', curved: '曲线', polyline: '折线' };
const editableLine = element => !element.isDeleted && !element.locked && ['line', 'arrow'].includes(element.type);
const normalizeScene = scene => JSON.parse(JSON.stringify({ ...scene, elements: restoreElements(scene.elements, null, { repairBindings: true }) }));

const LABELS = { loading: '正在加载', saved: '已保存', dirty: '待保存', saving: '保存中', offline: '离线 · 正在重试', conflict: '修改冲突 · 已暂停同步', warning: '备份提醒' };
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function Whiteboard({ sessionId, boardId = 'default', boardName = '协作白板', rpc, visible = true, signal, navigation = null, registerLeaveGuard, blocked = false }) {
  const [api, setApi] = useState(null);
  const [status, setStatus] = useState({ kind: 'loading', message: '' });
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [lineSelection, setLineSelection] = useState({ count: 0, style: null });
  // A stable portal target preserves the native editor, selection and undo stack.
  // Moving its DOM host escapes sidebar clipping without reparenting the React tree.
  const [surface] = useState(() => document.createElement('div'));
  const mountRef = useRef(null), expandRef = useRef(null);
  const expanded = fullscreen && visible && !signal?.aborted;
  const [retry, setRetry] = useState(0);
  const syncRef = useRef(null), timerRef = useRef(null), visibleRef = useRef(visible), busyRef = useRef(false);
  const [ready, setReady] = useState(false);
  visibleRef.current = visible;
  const onApi = useCallback(value => setApi(value), []);
  const finishInteraction = useCallback(() => {
    if (!busyRef.current) return;
    busyRef.current = false;
    const sync = syncRef.current;
    clearTimeout(timerRef.current);
    // Let native pointer-up/finalization handlers finish before syncing a scene.
    timerRef.current = setTimeout(() => {
      if (visibleRef.current && !busyRef.current && syncRef.current === sync) void sync?.tick();
    }, 0);
  }, []);
  useEffect(() => {
    // Native callbacks are not guaranteed on pointer cancellation or lost focus.
    window.addEventListener('pointerup', finishInteraction, true);
    window.addEventListener('pointercancel', finishInteraction, true);
    window.addEventListener('blur', finishInteraction);
    return () => {
      window.removeEventListener('pointerup', finishInteraction, true);
      window.removeEventListener('pointercancel', finishInteraction, true);
      window.removeEventListener('blur', finishInteraction);
    };
  }, [finishInteraction]);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    setReady(false); setStatus({ kind: 'loading', message: '' });
    const requests = new AbortController();
    const sync = new BoardSync({
      read: () => rpc('get', { sessionId, boardId }, requests.signal),
      write: (baseRevision, scene) => rpc('save', { sessionId, boardId, baseRevision, scene }, requests.signal),
      recovery: recoveryFor(sessionId, boardId),
      normalize: normalizeScene,
      onStatus: (kind, message = '') => { if (alive) setStatus({ kind, message }); },
      onScene: (scene, { initial }) => {
        if (!alive) return;
        api.addFiles(structuredClone(Object.values(scene.files)));
        api.updateScene({
          // Native editors may mutate element objects; never hand out the CAS baseline.
          elements: structuredClone(scene.elements),
          appState: { selectedElementIds: Object.fromEntries(scene.selectedIds.map(id => [id, true])) },
          captureUpdate: initial ? CaptureUpdateAction.NEVER : CaptureUpdateAction.IMMEDIATELY,
        });
        if (initial) {
          api.history.clear();
          if (scene.elements.some(e => !e.isDeleted)) api.scrollToContent(undefined, { fitToContent: true });
        }
        setReady(true);
      },
    });
    syncRef.current = sync;
    sync.start().catch(error => { if (alive) setStatus({ kind: 'offline', message: `加载失败：${error.message}` }); });
    const interval = setInterval(() => { if (visibleRef.current && !busyRef.current) void sync.tick(); }, 1000);
    const closed = () => { clearInterval(interval); sync.dispose(); requests.abort(); };
    signal?.addEventListener('abort', closed, { once: true });
    if (signal?.aborted) closed();
    return () => {
      alive = false; clearInterval(interval); clearTimeout(timerRef.current);
      signal?.removeEventListener('abort', closed); sync.dispose(); requests.abort();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [api, sessionId, boardId, rpc, signal, retry]);
  useLayoutEffect(() => {
    const parent = expanded ? document.body : mountRef.current;
    surface.className = `dsh-wb-surface${expanded ? ' dsh-wb-surface--expanded' : ''}`;
    if (surface.parentNode !== parent) {
      const focused = document.activeElement;
      parent?.appendChild(surface);
      if (visible && !signal?.aborted && surface.contains(focused)) focused?.focus({ preventScroll: true });
    }
    // Layout changed, not content: don't fit/reset the user's zoom or pan.
    api?.refresh();
    const frame = requestAnimationFrame(() => { if (!signal?.aborted && visible) api?.refresh(); });
    return () => cancelAnimationFrame(frame);
  }, [surface, expanded, api, visible, signal]);
  useEffect(() => {
    if (!visible) {
      setFullscreen(false); busyRef.current = false;
      api?.updateScene({ appState: { openDialog: null, openMenu: null, openPopup: null }, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }, [visible, api]);
  useEffect(() => {
    const close = () => {
      // Abort may happen while a hidden tab is still mounted. Remove overlay now.
      surface.className = 'dsh-wb-surface';
      if (mountRef.current) mountRef.current.appendChild(surface); else surface.remove();
      busyRef.current = false;
      api?.updateScene({ appState: { openDialog: null, openMenu: null, openPopup: null }, captureUpdate: CaptureUpdateAction.NEVER });
      setFullscreen(false);
    };
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close();
    return () => signal?.removeEventListener('abort', close);
  }, [signal, surface, api]);
  useLayoutEffect(() => () => surface.remove(), [surface]);
  function changeZoom(value) {
    if (!api) return;
    const next = zoomAtCenter(api.getAppState(), value);
    api.updateScene({ appState: next, captureUpdate: CaptureUpdateAction.NEVER });
    setZoom(next.zoom.value);
  }
  function onKeyDownCapture(event) {
    if (!expanded || event.key !== 'Escape' || event.defaultPrevented || event.isComposing || busyRef.current) return;
    const state = api?.getAppState();
    const target = event.target;
    // Native Excalidraw stops Escape in bubble phase. Capture only a truly idle
    // Escape; editing, selections, menus and body-portaled dialogs keep priority.
    if (target?.isContentEditable || target?.closest?.('input, textarea, select, [role="dialog"], .Modal, details[open]')) return;
    if (!state || state.editingTextElement || state.editingLinearElement || state.editingFrame || state.editingGroupId || state.newElement || state.multiElement || state.selectionElement || state.isResizing || state.isRotating || state.selectedElementsAreBeingDragged || state.openDialog || state.openMenu || state.openPopup || state.pasteDialog?.shown || Object.values(state.selectedElementIds ?? {}).some(Boolean) || (state.activeTool && state.activeTool.type !== 'selection')) return;
    event.preventDefault(); event.stopPropagation();
    setFullscreen(false);
    expandRef.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    const unload = event => {
      if (syncRef.current?.dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  const onChange = useCallback((elements, appState, files) => {
    if (appState.zoom) setZoom(appState.zoom.value);
    const selectedLines = elements.filter(element => editableLine(element) && appState.selectedElementIds?.[element.id]);
    const styles = new Set(selectedLines.map(element => element.elbowed ? 'polyline' : element.roundness ? 'curved' : element.points.length > 2 ? 'polyline' : 'straight'));
    const style = styles.size === 1 ? [...styles][0] : null;
    setLineSelection(previous => previous.count === selectedLines.length && previous.style === style ? previous : { count: selectedLines.length, style });
    const sync = syncRef.current;
    if (!sync?.base || sync.disposed) return;
    // Image placement is transient until Excalidraw attaches its embedded file.
    if (elements.some(e => !e.isDeleted && e.type === 'image' && e.fileId == null)) return;
    const { rejected, scene } = safeNativeInput(elements, files, Object.keys(appState.selectedElementIds).filter(id => appState.selectedElementIds[id]));
    if (rejected) {
      setStatus({ kind: 'warning', message: '未添加不支持的内容：首版不支持网页嵌入、SVG/GIF 图片；图片请用 PNG/JPEG/WebP。' });
      queueMicrotask(() => {
        if (syncRef.current !== sync || sync.disposed) return;
        api?.updateScene({ elements: structuredClone(sync.local.elements), appState: { selectedElementIds: Object.fromEntries(sync.local.selectedIds.map(id => [id, true])), activeTool: { type: 'selection' } }, captureUpdate: CaptureUpdateAction.NEVER });
        api?.history.clear();
      });
      return;
    }
    sync.observe(scene);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { if (!busyRef.current) void sync.tick(); }, 550);
  }, [api]);
  useEffect(() => {
    if (!registerLeaveGuard) return;
    const leave = async () => {
      const sync = syncRef.current;
      if (signal?.aborted || !visibleRef.current) return false;
      if (!sync?.base) return true; // Loading canvas is hidden and has no editable draft.
      const state = api?.getAppState();
      if (!state || busyRef.current || state.editingTextElement || state.editingLinearElement || state.newElement || state.multiElement || state.isResizing || state.isRotating || state.selectedElementsAreBeingDragged) return false;
      // Capture synchronous native changes before awaiting any in-flight save.
      onChange(api.getSceneElementsIncludingDeleted(), state, api.getFiles());
      clearTimeout(timerRef.current);
      if (sync.paused) return false;
      await sync.tick();
      if (syncRef.current !== sync || sync.disposed || signal?.aborted) return false;
      if (sync.dirty && !sync.paused) await sync.tick();
      const latest = api.getAppState();
      return syncRef.current === sync && !sync.disposed && !signal?.aborted && !busyRef.current && !latest.editingTextElement && !latest.editingLinearElement && !latest.newElement && !latest.multiElement && !sync.dirty && !sync.paused && !sync.uncertainWrite;
    };
    return registerLeaveGuard(boardId, leave);
  }, [api, boardId, onChange, registerLeaveGuard, signal]);
  function changeLineStyle(lineStyle) {
    const sync = syncRef.current;
    if (!api || !sync?.base || sync.disposed || !visibleRef.current || signal?.aborted || busyRef.current || blocked) return;
    const state = api.getAppState();
    // Include deleted elements: replacing the native scene must not erase undo tombstones.
    const elements = api.getSceneElementsIncludingDeleted();
    const changed = new Map();
    try {
      for (const element of elements) {
        if (editableLine(element) && state.selectedElementIds?.[element.id]) changed.set(element.id, newElementWith(element, styleLinearElement(element, lineStyle)));
      }
    } catch (error) {
      setStatus({ kind: 'warning', message: `暂未转换连线：${error.message}` });
      return;
    }
    if (!changed.size) return;
    const next = elements.map(element => {
      if (changed.has(element.id)) return changed.get(element.id);
      if (!element.isDeleted && element.type === 'text' && changed.has(element.containerId)) {
        const [x, y] = linearPathMidpoint(changed.get(element.containerId));
        return newElementWith(element, { x: x - element.width / 2, y: y - element.height / 2 });
      }
      return element;
    });
    const appState = { ...state, editingLinearElement: null, selectedLinearElement: null };
    api.updateScene({ elements: next, appState: { editingLinearElement: null, selectedLinearElement: null }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    // Capture the edit immediately for source export and crash recovery as well;
    // native onChange is asynchronous and must not be the only owner of this edit.
    onChange(next, appState, api.getFiles());
  }
  async function exportFile(format) {
    try {
      if (!api) return;
      const elements = api.getSceneElements(); const appState = api.getAppState(); const files = api.getFiles();
      const label = boardName.replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 50) || 'whiteboard';
      const name = `${label}-${boardId.slice(0, 12)}-${sessionId.slice(0, 12)}`;
      if (format === 'excalidraw') {
        const local = syncRef.current?.local;
        download(new Blob([serializeAsJSON(local?.elements ?? elements, appState, local?.files ?? files, 'local')], { type: 'application/json' }), `${name}.excalidraw`);
      } else if (format === 'png') {
        const blob = await exportToBlob({ elements, appState: { ...appState, exportBackground: true }, files, mimeType: 'image/png' });
        if (blob) download(blob, `${name}.png`);
      } else {
        const svg = await exportToSvg({ elements, appState: { ...appState, exportBackground: true }, files });
        download(new Blob([svg.outerHTML], { type: 'image/svg+xml' }), `${name}.svg`);
      }
    } catch (error) { setStatus({ kind: 'warning', message: `导出失败：${error.message}` }); }
  }
  async function reloadRemote() {
    if (!window.confirm('将放弃本地未保存的修改并加载服务器版本。建议先点“源文件”下载备份。继续？')) return;
    try { await syncRef.current.discardLocalAndReload(); }
    catch (error) { setStatus({ kind: 'offline', message: error.message }); }
  }
  return <><div className="dsh-wb-mount" ref={mountRef} />{createPortal(<section className="dsh-whiteboard" aria-label="AI 协作白板" onKeyDownCapture={onKeyDownCapture} onKeyDown={event => event.stopPropagation()}>
    <header className="dsh-wb-header">
      <strong title={boardName}>✎ {boardName}</strong>
      <span className={`dsh-wb-status dsh-wb-status--${status.kind}`} role="status" title={status.message}>{LABELS[status.kind] ?? status.kind}</span>
      <button ref={expandRef} className="dsh-wb-expand" onClick={() => setFullscreen(f => !f)} aria-label={expanded ? '返回侧栏' : '大屏编辑'} aria-expanded={expanded} title={expanded ? '返回侧栏（Esc）' : '在页面大屏中编辑，不丢失当前视图和撤销历史'}>{expanded ? '↙ 返回侧栏' : '⤢ 大屏编辑'}</button>
    </header>
    {navigation}
    <div className="dsh-wb-actions">
      <div className="dsh-wb-zoom" role="group" aria-label="画布缩放">
        <button disabled={!ready || zoom <= MIN_ZOOM} onClick={() => changeZoom(api.getAppState().zoom.value / 1.25)} aria-label="缩小画布" title="缩小画布">−</button>
        <button disabled={!ready} onClick={() => changeZoom(1)} aria-label="重置缩放为 100%" title="点击恢复 100%">{Math.round(zoom * 100)}%</button>
        <button disabled={!ready || zoom >= MAX_ZOOM} onClick={() => changeZoom(api.getAppState().zoom.value * 1.25)} aria-label="放大画布" title="放大画布">＋</button>
      </div>
      <div className="dsh-wb-lines" role="group" aria-label="选中连线走线" title={lineSelection.count ? `修改 ${lineSelection.count} 条未锁定的连线` : '先用选择工具选中线条或箭头'}>
        <span>连线</span>{LINE_STYLES.map(lineStyle => <button key={lineStyle} disabled={!ready || !lineSelection.count || !visible || signal?.aborted || blocked} aria-label={`连线：${LINE_LABELS[lineStyle]}`} aria-pressed={lineSelection.style === lineStyle} onClick={() => changeLineStyle(lineStyle)}>{LINE_LABELS[lineStyle]}</button>)}
      </div>
      <button disabled={!ready} onClick={() => api?.scrollToContent(undefined, { fitToContent: true })}>适应</button>
      <button disabled={!ready || blocked} onClick={() => syncRef.current?.tick()}>保存</button>
      <details className="dsh-wb-export"><summary>导出 ▾</summary><div>
        <button disabled={!ready} onClick={() => exportFile('png')}>PNG</button>
        <button disabled={!ready} onClick={() => exportFile('svg')}>SVG</button>
        <button disabled={!ready} onClick={() => exportFile('excalidraw')}>源文件</button>
      </div></details>
    </div>
    {status.message && <div className="dsh-wb-notice" role="alert">{status.message}
      {status.kind === 'conflict' && <button onClick={reloadRemote}>加载服务器版本</button>}
      {!ready && status.kind === 'offline' && <button onClick={() => setRetry(n => n + 1)}>重新加载</button>}
    </div>}
    <div className="dsh-wb-canvas" inert={blocked ? '' : undefined} aria-busy={blocked || undefined} style={{ visibility: ready ? 'visible' : 'hidden' }}>
      <Excalidraw excalidrawAPI={onApi} onChange={onChange} langCode="zh-CN" name={boardName}
        handleKeyboardGlobally={false} autoFocus={false} aiEnabled={false} validateEmbeddable={false}
        onLinkOpen={(_element, event) => event.preventDefault()}
        onPointerDown={() => { busyRef.current = true; }}
        onPointerUp={finishInteraction}
        UIOptions={{ canvasActions: { loadScene: false, export: false, saveAsImage: false, saveToActiveFile: false } }}>
        <MainMenu><MainMenu.DefaultItems.ClearCanvas /><MainMenu.DefaultItems.ToggleTheme /></MainMenu>
      </Excalidraw>
    </div>
    {!ready && <div className="dsh-wb-loading">{status.kind === 'offline' ? '画板暂未加载，请重试。' : '正在准备画板…'}</div>}
    <footer className="dsh-wb-hint">{expanded ? '大屏编辑 · Esc 返回侧栏 · 缩放不改变共享图形。' : '侧栏太窄？点右上角“大屏编辑”。在聊天中告诉 AI 想画什么。'}</footer>
  </section>, surface)}</>;
}
