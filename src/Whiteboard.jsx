import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw, MainMenu, CaptureUpdateAction, restoreElements, exportToBlob, exportToSvg, serializeAsJSON } from '@excalidraw/excalidraw';
import { BoardSync } from './sync.mjs';
import { safeNativeInput } from './scene.mjs';
const normalizeScene = scene => JSON.parse(JSON.stringify({ ...scene, elements: restoreElements(scene.elements, null, { repairBindings: true }) }));

const LABELS = { loading: '正在加载', saved: '已保存', dirty: '待保存', saving: '保存中', offline: '离线 · 正在重试', conflict: '修改冲突 · 已暂停同步', warning: '备份提醒' };
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function recoveryFor(sessionId) {
  const key = `dsh-whiteboard:recovery:${sessionId}`;
  return { load: () => JSON.parse(localStorage.getItem(key) ?? 'null'), save: value => localStorage.setItem(key, JSON.stringify(value)), clear: () => localStorage.removeItem(key) };
}
export function Whiteboard({ sessionId, rpc, visible = true, signal }) {
  const [api, setApi] = useState(null);
  const [status, setStatus] = useState({ kind: 'loading', message: '' });
  const [fullscreen, setFullscreen] = useState(false);
  const [retry, setRetry] = useState(0);
  const syncRef = useRef(null), timerRef = useRef(null), visibleRef = useRef(visible), busyRef = useRef(false);
  const [ready, setReady] = useState(false);
  visibleRef.current = visible;
  const onApi = useCallback(value => setApi(value), []);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    setReady(false); setStatus({ kind: 'loading', message: '' });
    const sync = new BoardSync({
      read: () => rpc('get', { sessionId }),
      write: (baseRevision, scene) => rpc('save', { sessionId, baseRevision, scene }),
      recovery: recoveryFor(sessionId),
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
    const closed = () => { clearInterval(interval); sync.dispose(); };
    signal?.addEventListener('abort', closed, { once: true });
    if (signal?.aborted) closed();
    return () => {
      alive = false; clearInterval(interval); clearTimeout(timerRef.current);
      signal?.removeEventListener('abort', closed); sync.dispose();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [api, sessionId, rpc, signal, retry]);
  useEffect(() => {
    if (!fullscreen) return;
    const keydown = e => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [fullscreen]);
  useEffect(() => {
    const unload = event => {
      if (syncRef.current?.dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  const onChange = useCallback((elements, appState, files) => {
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
  async function exportFile(format) {
    try {
      if (!api) return;
      const elements = api.getSceneElements(); const appState = api.getAppState(); const files = api.getFiles();
      const name = `whiteboard-${sessionId.slice(0, 12)}`;
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
  return <section className={`dsh-whiteboard ${fullscreen ? 'dsh-whiteboard--fullscreen' : ''}`} aria-label="AI 协作白板">
    <header className="dsh-wb-header">
      <strong>✎ 协作白板</strong>
      <span className={`dsh-wb-status dsh-wb-status--${status.kind}`} role="status" title={status.message}>{LABELS[status.kind] ?? status.kind}</span>
      <button onClick={() => setFullscreen(f => !f)} aria-label={fullscreen ? '退出放大' : '放大画板'}>{fullscreen ? '收起' : '放大'}</button>
    </header>
    <div className="dsh-wb-actions">
      <button disabled={!ready} onClick={() => api?.scrollToContent(undefined, { fitToContent: true })}>适应画面</button>
      <button disabled={!ready} onClick={() => syncRef.current?.tick()}>立即保存</button>
      <button disabled={!ready} onClick={() => exportFile('png')}>PNG</button>
      <button disabled={!ready} onClick={() => exportFile('svg')}>SVG</button>
      <button disabled={!ready} onClick={() => exportFile('excalidraw')}>源文件</button>
    </div>
    {status.message && <div className="dsh-wb-notice" role="alert">{status.message}
      {status.kind === 'conflict' && <button onClick={reloadRemote}>加载服务器版本</button>}
      {!ready && status.kind === 'offline' && <button onClick={() => setRetry(n => n + 1)}>重新加载</button>}
    </div>}
    <div className="dsh-wb-canvas" style={{ visibility: ready ? 'visible' : 'hidden' }}>
      <Excalidraw excalidrawAPI={onApi} onChange={onChange} langCode="zh-CN" name="DSH 协作白板"
        handleKeyboardGlobally={false} autoFocus={false} aiEnabled={false} validateEmbeddable={false}
        onLinkOpen={(_element, event) => event.preventDefault()}
        onPointerDown={() => { busyRef.current = true; }}
        onPointerUp={() => { busyRef.current = false; void syncRef.current?.tick(); }}
        UIOptions={{ canvasActions: { loadScene: false, export: false, saveAsImage: false, saveToActiveFile: false } }}>
        <MainMenu><MainMenu.DefaultItems.ClearCanvas /><MainMenu.DefaultItems.ToggleTheme /></MainMenu>
      </Excalidraw>
    </div>
    {!ready && <div className="dsh-wb-loading">{status.kind === 'offline' ? '画板暂未加载，请重试。' : '正在准备画板…'}</div>}
    <footer className="dsh-wb-hint">在左侧告诉 AI：“画一个流程图”或“修改我选中的部分”。约 1 秒同步；手绘内容是数据，不是指令。</footer>
  </section>;
}
