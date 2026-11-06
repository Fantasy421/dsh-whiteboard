import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { zoomAtCenter, MIN_ZOOM, MAX_ZOOM } from './viewport.mjs';
import { Excalidraw, MainMenu, CaptureUpdateAction, restoreElements, newElementWith, exportToBlob, exportToSvg, serializeAsJSON } from '@excalidraw/excalidraw';
import { LINE_STYLES, styleLinearElement, linearPathMidpoint } from './linear.mjs';
import { BoardSync } from './sync.mjs';
import { safeNativeInput } from './scene.mjs';
import { recoveryFor } from './recovery.mjs';
import { HeaderMenu, HeaderMenuContext } from './header.jsx';
import { hitReadingNode, readingNeighborhood } from './reading.mjs';
import { ReadingOverlay } from './ReadingOverlay.jsx';
const idleForReading = state => state && !state.editingTextElement && !state.editingLinearElement && !state.newElement && !state.multiElement && !state.isResizing && !state.isRotating && !state.selectedElementsAreBeingDragged && !state.openDialog;
const readingViewport = state => ({ zoom: state.zoom?.value ?? 1, scrollX: state.scrollX ?? 0, scrollY: state.scrollY ?? 0, frameEnabled: state.frameRendering?.enabled !== false, frameClip: state.frameRendering?.clip !== false });
const LINE_LABELS = { straight: '直线', curved: '曲线', polyline: '折线' };
const editableLine = element => !element.isDeleted && !element.locked && ['line', 'arrow'].includes(element.type);
const normalizeScene = scene => JSON.parse(JSON.stringify({ ...scene, elements: restoreElements(scene.elements, null, { repairBindings: true }) }));

const LABELS = { loading: '正在加载', saved: '已保存', dirty: '待保存', saving: '保存中', offline: '离线 · 正在重试', conflict: '修改冲突 · 已暂停同步', warning: '备份提醒' };
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function Whiteboard({ sessionId, boardId = 'default', boardName = '协作白板', rpc, visible = true, signal, navigation = null, navigationNotice = null, registerLeaveGuard, blocked = false }) {
  const [api, setApi] = useState(null);
  const [status, setStatus] = useState({ kind: 'loading', message: '' });
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [lineSelection, setLineSelection] = useState({ count: 0, style: null });
  const [menu, setMenu] = useState(null);
  const [reading, setReading] = useState(false), [readingFocus, setReadingFocus] = useState(null);
  const [readingScene, setReadingScene] = useState([]), [readingView, setReadingView] = useState({ zoom: 1, scrollX: 0, scrollY: 0 });
  const readingRef = useRef(false), readingSignature = useRef(null), selectionGuardRef = useRef(null);
  const readingPointer = useRef(null), readingPointers = useRef(new Set()), selectionRestoreRef = useRef(null);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const captureReadingView = useCallback((elements, state) => {
    const signature = JSON.stringify(elements.map(element => [element.id, element.version, element.versionNonce, element.isDeleted]));
    if (readingSignature.current !== signature) {
      readingSignature.current = signature;
      setReadingScene(structuredClone(elements));
    }
    const next = readingViewport(state);
    setReadingView(previous => previous.zoom === next.zoom && previous.scrollX === next.scrollX && previous.scrollY === next.scrollY && previous.frameEnabled === next.frameEnabled && previous.frameClip === next.frameClip ? previous : next);
  }, []);
  const summaryRefs = useRef(new Map());
  const [menuRoot, setMenuRoot] = useState(null);
  const menus = useMemo(() => ({ active: menu, setActive: setMenu, summaries: summaryRefs, panelRoot: menuRoot }), [menu, menuRoot]);
  // A stable portal target preserves the native editor, selection and undo stack.
  // Moving its DOM host escapes sidebar clipping without reparenting the React tree.
  const [surface] = useState(() => document.createElement('div'));
  const mountRef = useRef(null), expandRef = useRef(null);
  const expanded = fullscreen && visible && !signal?.aborted;
  const [retry, setRetry] = useState(0);
  const syncRef = useRef(null), timerRef = useRef(null), visibleRef = useRef(visible), busyRef = useRef(false);
  const rejectingRef = useRef(null);
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
        if (readingRef.current) captureReadingView(scene.elements, api.getAppState());
        api.addFiles(structuredClone(Object.values(scene.files)));
        api.updateScene({
          // Native editors may mutate element objects; never hand out the CAS baseline.
          elements: structuredClone(scene.elements),
          appState: { selectedElementIds: readingRef.current ? {} : Object.fromEntries(scene.selectedIds.map(id => [id, true])) },
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
      setFullscreen(false); setMenu(null); busyRef.current = false;
      api?.updateScene({ appState: { openDialog: null, openMenu: null, openPopup: null, contextMenu: null }, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }, [visible, api]);
  useEffect(() => {
    const close = () => {
      // Abort may happen while a hidden tab is still mounted. Remove overlay now.
      surface.className = 'dsh-wb-surface';
      if (mountRef.current) mountRef.current.appendChild(surface); else surface.remove();
      busyRef.current = false;
      api?.updateScene({ appState: { openDialog: null, openMenu: null, openPopup: null, contextMenu: null }, captureUpdate: CaptureUpdateAction.NEVER });
      readingRef.current = false; setReading(false); setReadingFocus(null);
      setFullscreen(false); setMenu(null);
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
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    const state = api?.getAppState();
    const target = event.target;
    // Header menus get one Escape before an idle fullscreen exit. Native dialogs
    // and unfinished drawing/text input retain priority even if a menu is open.
    const nativeBusy = busyRef.current || state?.editingTextElement || state?.editingLinearElement || state?.newElement || state?.multiElement || state?.isResizing || state?.isRotating;
    if (menu && !nativeBusy && !state?.openDialog && !state?.openMenu && !state?.openPopup && !state?.contextMenu && state?.showHyperlinkPopup !== 'editor' && !state?.pasteDialog?.shown && !target?.closest?.('[role="dialog"], .Modal')) {
      event.preventDefault(); event.stopPropagation();
      setMenu(null); summaryRefs.current.get(menu)?.focus({ preventScroll: true });
      return;
    }
    if (readingRef.current && readingFocus && !nativeBusy && !state?.openDialog && !state?.openMenu && !state?.contextMenu && !state?.openPopup && !target?.closest?.('input, textarea, select, [role="dialog"], .Modal')) {
      event.preventDefault(); event.stopPropagation(); setReadingFocus(null); return;
    }
    if (!expanded || busyRef.current) return;
    // Native Excalidraw stops Escape in bubble phase. Capture only a truly idle
    // Escape; editing, selections, menus and body-portaled dialogs keep priority.
    if (target?.isContentEditable || target?.closest?.('input, textarea, select, [role="dialog"], .Modal, details[open]')) return;
    if (!state || state.editingTextElement || state.editingLinearElement || state.editingFrame || state.editingGroupId || state.newElement || state.multiElement || state.selectionElement || state.isResizing || state.isRotating || state.selectedElementsAreBeingDragged || state.openDialog || state.openMenu || state.openPopup || state.contextMenu || state.showHyperlinkPopup === 'editor' || state.pasteDialog?.shown || Object.values(state.selectedElementIds ?? {}).some(Boolean) || (!readingRef.current && state.activeTool && state.activeTool.type !== 'selection')) return;
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
    const sync = syncRef.current;
    // Excalidraw calls onChange on every componentDidUpdate, including updates
    // caused by our warning. Stop re-entry BEFORE any parent state writes; a
    // microtask alone cannot break React's synchronous update-depth loop.
    if (sync && rejectingRef.current === sync) return;
    if (appState.zoom) setZoom(appState.zoom.value);
    if (readingRef.current && sync?.local) captureReadingView(sync.local.elements, appState);
    const selectedLines = elements.filter(element => editableLine(element) && appState.selectedElementIds?.[element.id]);
    const styles = new Set(selectedLines.map(element => element.elbowed ? 'polyline' : element.roundness ? 'curved' : element.points.length > 2 ? 'polyline' : 'straight'));
    const style = styles.size === 1 ? [...styles][0] : null;
    setLineSelection(previous => previous.count === selectedLines.length && previous.style === style ? previous : { count: selectedLines.length, style });
    if (!sync?.base || sync.disposed) return;
    if (readingRef.current) {
      // Reading callbacks never observe native edits or deselection into the CAS
      // scene. Remote onScene already updates sync.local before native rendering.
      const accepted = sync.local.elements;
      if (elements.length !== accepted.length || elements.some((element, i) => element.id !== accepted[i]?.id || element.version !== accepted[i]?.version || element.versionNonce !== accepted[i]?.versionNonce || element.isDeleted !== accepted[i]?.isDeleted)) {
        rejectingRef.current = sync;
        queueMicrotask(() => {
          try {
            if (syncRef.current !== sync || sync.disposed || !readingRef.current) return;
            api?.updateScene({ elements: structuredClone(sync.local.elements), appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
          } finally { if (rejectingRef.current === sync) rejectingRef.current = null; }
        });
      }
      return;
    }
    // Image placement is transient until Excalidraw attaches its embedded file.
    if (elements.some(e => !e.isDeleted && e.type === 'image' && e.fileId == null)) return;
    // Native file caches are additive. A delayed image rejected during reading
    // can leave an unreferenced file behind; never turn that cache into an edit
    // on mode exit. Retain accepted files and image tombstone files for undo.
    const imageFiles = new Set(elements.filter(element => element.type === 'image').map(element => element.fileId));
    const sceneFiles = Object.fromEntries(Object.entries(files).filter(([id]) => imageFiles.has(id) || Object.hasOwn(sync.local.files, id)));
    const { rejected, scene } = safeNativeInput(elements, sceneFiles, Object.keys(appState.selectedElementIds).filter(id => appState.selectedElementIds[id]));
    const unsupportedTool = ['embeddable', 'magicframe'].includes(appState.activeTool?.type);
    if (rejected || unsupportedTool) {
      rejectingRef.current = sync;
      const message = '当前白板不支持网页嵌入、SVG/GIF 图片，未添加这些内容；原有图形已保留。图片请用 PNG/JPEG/WebP。';
      setStatus(previous => previous.kind === 'warning' && previous.message === message ? previous : { kind: 'warning', message });
      queueMicrotask(() => {
        try {
          if (syncRef.current !== sync || sync.disposed) return;
          clearTimeout(timerRef.current); busyRef.current = false;
          // Use the public setter: updateScene shallow-replaces activeTool and
          // would otherwise drop native locked/lastActiveTool/customType fields.
          api?.setActiveTool({ type: 'selection' });
          api?.updateScene({
            elements: structuredClone(sync.local.elements),
            appState: {
              selectedElementIds: Object.fromEntries(sync.local.selectedIds.map(id => [id, true])),
              selectedGroupIds: {}, editingGroupId: null, hoveredElementIds: {},
              newElement: null, multiElement: null, resizingElement: null, selectionElement: null,
              editingTextElement: null, editingLinearElement: null, selectedLinearElement: null,
              activeEmbeddable: null, startBoundElement: null, suggestedBindings: [],
              pendingImageElementId: null, isResizing: false, isRotating: false,
              selectedElementsAreBeingDragged: false, cursorButton: 'up',
              openDialog: null, showHyperlinkPopup: false, snapLines: [], originSnapOffset: null,
            },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          // Do not erase the user's undo history just because an input is unsupported.
        } finally {
          if (rejectingRef.current === sync) rejectingRef.current = null;
        }
      });
      return;
    }
    // Native view-mode transitions deselect elements. That is local navigation,
    // not a shared selection edit. Keep the accepted selection through both
    // transitions and restore it only after native view mode has actually ended.
    if (readingRef.current || appState.viewModeEnabled || selectionGuardRef.current === sync) {
      scene.selectedIds = [...sync.local.selectedIds];
      if (!readingRef.current && !appState.viewModeEnabled && selectionGuardRef.current === sync) {
        const selected = Object.keys(appState.selectedElementIds ?? {}).filter(id => appState.selectedElementIds[id]);
        if (selectionRestoreRef.current?.sync === sync && selectionRestoreRef.current.applied && selected.length === sync.local.selectedIds.length && selected.every(id => sync.local.selectedIds.includes(id))) {
          selectionGuardRef.current = null; selectionRestoreRef.current = null;
        } else if (selectionRestoreRef.current?.sync !== sync) {
          const restoration = { sync, applied: false };
          selectionRestoreRef.current = restoration;
          // The native prop-change callback precedes another queued deselection.
          // Never release this guard on that first, pre-deselection callback.
          queueMicrotask(() => {
            if (syncRef.current !== sync || sync.disposed || readingRef.current || selectionRestoreRef.current !== restoration) return;
            restoration.applied = true;
            api?.updateScene({ appState: { selectedElementIds: Object.fromEntries(sync.local.selectedIds.map(id => [id, true])) }, captureUpdate: CaptureUpdateAction.NEVER });
          });
        }
      }
    }
    sync.observe(scene);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { if (!busyRef.current) void sync.tick(); }, 550);
  }, [api, captureReadingView]);
  function toggleReading() {
    const sync = syncRef.current, state = api?.getAppState();
    if (!ready || !visibleRef.current || signal?.aborted || blocked || !sync?.base || sync.disposed) return;
    if (busyRef.current || !idleForReading(state)) {
      setStatus({ kind: 'warning', message: '请先结束当前绘图、文字输入或弹窗，再切换阅读模式。' });
      return;
    }
    // Preserve any already accepted unsaved edits before changing native view mode.
    if (!readingRef.current) onChange(api.getSceneElementsIncludingDeleted(), state, api.getFiles());
    selectionGuardRef.current = sync; selectionRestoreRef.current = null;
    readingRef.current = !readingRef.current;
    readingPointer.current = null; readingPointers.current.clear();
    setReading(readingRef.current); setReadingFocus(null); setMenu(null);
    if (readingRef.current) captureReadingView(api.getSceneElementsIncludingDeleted(), state);
  }
  function blockReadingInput(event) {
    if (readingRef.current) { event.preventDefault(); event.stopPropagation(); }
  }
  function onReadingPointerDown(event) {
    if (!readingRef.current || !ready || !visibleRef.current || blockedRef.current || signal?.aborted || event.target?.tagName !== 'CANVAS') return;
    readingPointers.current.add(event.pointerId);
    if (readingPointers.current.size !== 1 || event.isPrimary === false || event.button !== 0) { readingPointer.current = null; return; }
    const state = api?.getAppState(), sync = syncRef.current;
    if (!sync?.base || sync.disposed || state?.openMenu || state?.contextMenu || state?.openDialog || state?.openPopup) return;
    busyRef.current = true;
    readingPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: Date.now(), sync,
      point: { x: (event.clientX - (state.offsetLeft ?? 0)) / state.zoom.value - state.scrollX, y: (event.clientY - (state.offsetTop ?? 0)) / state.zoom.value - state.scrollY } };
  }
  useEffect(() => {
    if (!reading) return;
    const cancel = () => { readingPointer.current = null; readingPointers.current.clear(); };
    const move = event => {
      const pointer = readingPointer.current;
      if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) readingPointer.current = null;
    };
    const up = event => {
      const pointer = readingPointer.current;
      readingPointers.current.delete(event.pointerId);
      if (pointer?.id !== event.pointerId) return;
      readingPointer.current = null;
      if (!readingRef.current || !visibleRef.current || blockedRef.current || signal?.aborted || pointer.sync !== syncRef.current || pointer.sync.disposed || Date.now() - pointer.time > 600 || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) return;
      setReadingFocus(hitReadingNode(api.getSceneElements(), pointer.point, { frameRendering: api.getAppState().frameRendering }));
    };
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true); window.addEventListener('blur', cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    return () => {
      cancel(); window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('blur', cancel);
      signal?.removeEventListener('abort', cancel);
    };
  }, [api, signal, reading]);
  useEffect(() => {
    if (!visible || blocked || signal?.aborted) { readingPointer.current = null; readingPointers.current.clear(); setReadingFocus(null); }
  }, [visible, blocked, signal]);
  useEffect(() => {
    if (readingFocus && !readingNeighborhood(readingScene, readingFocus).focusId) setReadingFocus(null);
  }, [readingScene, readingFocus]);
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
    if (!api || !sync?.base || sync.disposed || !visibleRef.current || signal?.aborted || busyRef.current || blocked || readingRef.current) return;
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
  return <><div className="dsh-wb-mount" ref={mountRef} />{createPortal(<HeaderMenuContext.Provider value={menus}><section className="dsh-whiteboard" aria-label="AI 协作白板" onKeyDownCapture={onKeyDownCapture} onKeyDown={event => event.stopPropagation()}>
    <header className="dsh-wb-header">
      {navigation || <strong title={boardName}>✎ {boardName}</strong>}
      <span className={`dsh-wb-status dsh-wb-status--${status.kind}`} role="status" title={status.message || LABELS[status.kind]}>{LABELS[status.kind] ?? status.kind}</span>
      {reading && <button className="dsh-wb-reading-active" aria-label="退出阅读模式" aria-pressed="true" onClick={toggleReading} disabled={blocked || !visible || signal?.aborted} title="仅本地高亮；点击返回编辑">阅读中</button>}
      <button ref={expandRef} className="dsh-wb-expand" onClick={() => { setMenu(null); setFullscreen(f => !f); }} aria-label={expanded ? '返回侧栏' : '大屏编辑'} aria-expanded={expanded} title={expanded ? '返回侧栏（Esc）' : '在页面大屏中编辑，不丢失当前视图和撤销历史'}>{expanded ? '↙ 返回' : '⤢ 大屏'}</button>
      <HeaderMenu id="tools" label="更多白板操作" summary="···" title="缩放、保存和导出；选中连线时可一键调整线型" visible={visible} signal={signal} className="dsh-wb-more">
        <div className="dsh-wb-menu-group" role="group" aria-label="阅读设置">
          <button aria-label="阅读模式" aria-pressed={reading} disabled={!ready || blocked || !visible || signal?.aborted} onClick={toggleReading}>{reading ? '返回编辑' : '阅读模式'}</button>
          <span>只读浏览；点击节点高亮直接关联，不改变共享图形。</span>
        </div>
        <div className="dsh-wb-menu-group" role="group" aria-label="画布缩放">
          <span>视图</span><div className="dsh-wb-zoom">
            <button disabled={!ready || zoom <= MIN_ZOOM} onClick={() => changeZoom(api.getAppState().zoom.value / 1.25)} aria-label="缩小画布" title="缩小画布">−</button>
            <button disabled={!ready} onClick={() => changeZoom(1)} aria-label="重置缩放为 100%" title="点击恢复 100%">{Math.round(zoom * 100)}%</button>
            <button disabled={!ready || zoom >= MAX_ZOOM} onClick={() => changeZoom(api.getAppState().zoom.value * 1.25)} aria-label="放大画布" title="放大画布">＋</button>
          </div><button disabled={!ready} onClick={() => api?.scrollToContent(undefined, { fitToContent: true })}>适应</button>
        </div>
        {!reading && lineSelection.count > 0 && <div className="dsh-wb-menu-group" role="group" aria-label="选中连线走线" title={`修改 ${lineSelection.count} 条未锁定的连线`}>
          <span>选中连线</span>{LINE_STYLES.map(lineStyle => <button key={lineStyle} disabled={!ready || !visible || signal?.aborted || blocked} aria-label={`连线：${LINE_LABELS[lineStyle]}`} aria-pressed={lineSelection.style === lineStyle} onClick={() => changeLineStyle(lineStyle)}>{LINE_LABELS[lineStyle]}</button>)}
        </div>}
        <div className="dsh-wb-menu-group" role="group" aria-label="保存和导出">
          <button disabled={!ready || blocked} onClick={() => syncRef.current?.tick()}>保存</button>
          <button disabled={!ready} onClick={() => exportFile('png')}>PNG</button>
          <button disabled={!ready} onClick={() => exportFile('svg')}>SVG</button>
          <button disabled={!ready} onClick={() => exportFile('excalidraw')}>源文件</button>
        </div>
      </HeaderMenu>
    </header>
    {navigationNotice && <div className="dsh-wb-navigation-alerts">{navigationNotice}</div>}
    {status.message && <div className="dsh-wb-notice" role="alert">{status.message}
      {status.kind === 'conflict' && <button onClick={reloadRemote}>加载服务器版本</button>}
      {!ready && status.kind === 'offline' && <button onClick={() => setRetry(n => n + 1)}>重新加载</button>}
    </div>}
    <div className="dsh-wb-stage"><div className="dsh-wb-canvas" onPointerDownCapture={onReadingPointerDown} onDropCapture={blockReadingInput} onDragOverCapture={blockReadingInput} onPasteCapture={blockReadingInput} onCutCapture={blockReadingInput} inert={blocked ? '' : undefined} aria-busy={blocked || undefined} style={{ visibility: ready ? 'visible' : 'hidden' }}>
      <Excalidraw excalidrawAPI={onApi} onChange={onChange} langCode="zh-CN" name={boardName}
        viewModeEnabled={reading} handleKeyboardGlobally={false} autoFocus={false} aiEnabled={false} validateEmbeddable={false}
        onLinkOpen={(_element, event) => event.preventDefault()}
        onPointerDown={() => { busyRef.current = true; }}
        onPointerUp={finishInteraction}
        UIOptions={{ canvasActions: { loadScene: false, export: false, saveAsImage: false, saveToActiveFile: false } }}>
        <MainMenu>{!reading && <MainMenu.DefaultItems.ClearCanvas />}<MainMenu.DefaultItems.ToggleTheme /></MainMenu>
      </Excalidraw>
      {reading && visible && !signal?.aborted && !blocked && <ReadingOverlay elements={readingScene} focusId={readingFocus} viewport={readingView} />}
    </div><div className="dsh-wb-menu-layer" ref={setMenuRoot} /></div>
    {!ready && <div className="dsh-wb-loading">{status.kind === 'offline' ? '画板暂未加载，请重试。' : '正在准备画板…'}</div>}
    <footer className="dsh-wb-hint">{reading ? (readingFocus ? '阅读模式 · 橙色为当前节点，蓝色为直接关联。点空白或 Esc 清除；拖动可平移。' : '阅读模式 · 点击节点查看流入/流出关联；不改原图。点“阅读中”返回编辑。') : expanded ? '大屏编辑 · Esc 返回侧栏 · 缩放不改变共享图形。' : '侧栏太窄？点右上角“大屏编辑”。在聊天中告诉 AI 想画什么。'}</footer>
  </section></HeaderMenuContext.Provider>, surface)}</>;
}
