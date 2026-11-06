import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Whiteboard } from './Whiteboard.jsx';
import { HeaderMenu } from './header.jsx';

const LEAVE_WARNING = '有未保存或冲突修改，请先保存或导出后处理';
const REQUEST_TIMEOUT = 10000;
let ownerSequence = 0;

function validateCatalog(value, sessionId) {
  if (!value || value.sessionId !== sessionId || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Array.isArray(value.boards) || !value.boards.length ||
      value.boards.some(board => !board || typeof board.id !== 'string' || !board.id || typeof board.name !== 'string') ||
      new Set(value.boards.map(board => board.id)).size !== value.boards.length ||
      !value.boards.some(board => board.id === value.activeBoardId)) {
    throw new Error('白板目录无效，请重试');
  }
  return value;
}

// A new owner must never render the previous session/occurrence's validated scene.
export function Boards({ sessionId, rpc, visible = true, signal }) {
  const owner = useMemo(() => ++ownerSequence, [sessionId, rpc, signal]);
  return <BoardsOwner key={owner} sessionId={sessionId} rpc={rpc} visible={visible} signal={signal} />;
}

function BoardsOwner({ sessionId, rpc, visible, signal }) {
  const [requests] = useState(() => new AbortController());
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [closed, setClosed] = useState(Boolean(signal?.aborted));
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null);
  const [name, setName] = useState('');
  const catalogRef = useRef(null), selectedRef = useRef(null), guards = useRef(new Map());
  const pendingRef = useRef(false), readRef = useRef(null), generation = useRef(0);
  const formInvoker = useRef(null), restoreFormFocus = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const alive = () => !requests.signal.aborted && !signal?.aborted;

  useEffect(() => {
    if (!form && !pending && restoreFormFocus.current) {
      restoreFormFocus.current = false;
      if (visible && alive()) formInvoker.current?.focus({ preventScroll: true });
    }
  }, [form, pending, visible, requests]);

  // Race even an RPC implementation that ignores AbortSignal. Late results can
  // neither mutate this owner nor occupy its serial/read gates indefinitely.
  async function bounded(operation) {
    const controller = new AbortController();
    let timer, abort;
    const cancellation = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(new Error('操作已取消')); };
      requests.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new Error('请求超时，操作结果未知')); }, REQUEST_TIMEOUT);
    });
    try {
      if (!alive()) throw new Error('操作已取消');
      return await Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }), cancellation]);
    } finally {
      clearTimeout(timer);
      requests.signal.removeEventListener('abort', abort);
    }
  }

  function choose(board) {
    selectedRef.current = board;
    setSelected(board);
  }
  function applyCatalog(next) {
    // Revisions are monotonic; an older read must not replace a newer CAS result.
    if (catalogRef.current && next.revision < catalogRef.current.revision) return;
    catalogRef.current = next;
    setCatalog(next);
    setError('');
    const current = selectedRef.current;
    if (!current) choose(next.boards.find(board => board.id === next.activeBoardId));
    else {
      const renamed = next.boards.find(board => board.id === current.id);
      if (renamed && renamed.name !== current.name) choose(renamed);
      // A missing selected ID deliberately retains its mounted draft for export.
    }
  }
  async function refresh({ reconcile = false } = {}) {
    if (!alive()) return;
    if (readRef.current) {
      if (!reconcile) return readRef.current;
      await readRef.current;
      if (!alive()) return;
    }
    const epoch = generation.current;
    setLoading(true);
    const read = (async () => {
      try {
        const next = validateCatalog(await bounded(requestSignal => rpc('list', { sessionId }, requestSignal)), sessionId);
        if (alive() && generation.current === epoch) applyCatalog(next);
      } catch (failure) {
        if (alive() && generation.current === epoch) setError(`目录加载失败：${failure.message}`);
      }
    })();
    readRef.current = read;
    try { await read; } finally {
      if (readRef.current === read) {
        readRef.current = null;
        if (alive()) setLoading(false);
      }
    }
  }

  useEffect(() => {
    const close = () => { requests.abort(); setClosed(true); };
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close();
    else void refresh();
    const interval = setInterval(() => {
      if (visibleRef.current && !pendingRef.current && !readRef.current && alive()) void refresh();
    }, 3000);
    return () => {
      clearInterval(interval);
      signal?.removeEventListener('abort', close);
      requests.abort();
      guards.current.clear();
    };
  }, []);

  const registerLeaveGuard = useCallback((boardId, guard) => {
    const entry = { guard };
    guards.current.set(boardId, entry);
    return () => { if (guards.current.get(boardId) === entry) guards.current.delete(boardId); };
  }, []);

  async function manage(action, { boardId, name: nextName } = {}) {
    if (!alive() || pendingRef.current || !catalogRef.current) return;
    if (action === 'activate' && selectedRef.current?.id === boardId) return;
    pendingRef.current = true;
    setPending(true); setNotice('');
    let wrote = false;
    try {
      const current = selectedRef.current;
      const swapsScene = action === 'activate' || action === 'create' || (action === 'delete' && boardId === current?.id);
      if (swapsScene) {
        const guard = guards.current.get(current?.id)?.guard;
        let allowed = false;
        try { allowed = Boolean(guard && await bounded(() => guard())); } catch { /* Treat failed save/guard as unsafe. */ }
        if (!alive()) return;
        if (!allowed) { setNotice(LEAVE_WARNING); return; }
      }
      if (!alive()) return;
      const baseline = catalogRef.current;
      if (action !== 'create' && !baseline.boards.some(board => board.id === boardId)) {
        setNotice('该白板已被删除；当前草稿仍可导出，请选择其他白板。');
        return;
      }
      if (action === 'delete' && baseline.boards.length <= 1) return;
      // Invalidate all reads begun before this intent, including a pre-guard poll.
      generation.current++;
      wrote = true;
      const payload = { sessionId, baseRevision: baseline.revision, action };
      if (boardId !== undefined) payload.boardId = boardId;
      if (nextName !== undefined) payload.name = nextName;
      const next = validateCatalog(await bounded(requestSignal => rpc('manage', payload, requestSignal)), sessionId);
      if (!alive()) return;
      if (action === 'activate' && next.activeBoardId !== boardId) throw new Error('服务器未确认切换白板');
      if (next.revision < baseline.revision) throw new Error('服务器返回了过期目录');
      applyCatalog(next);
      if (action === 'rename') restoreFormFocus.current = true;
      setForm(null); setName('');
      if (swapsScene) {
        // Blocking the native canvas during management closes most races, but a
        // delayed native change/save can still arrive after the first guard.
        const guard = guards.current.get(current?.id)?.guard;
        let stillSafe = false;
        try { stillSafe = Boolean(guard && await bounded(() => guard())); } catch { /* Keep the draft. */ }
        if (!alive()) return;
        if (!stillSafe) { setNotice(`${LEAVE_WARNING}；目录操作已完成，当前草稿仍保留，请检查列表。`); return; }
        choose(next.boards.find(board => board.id === next.activeBoardId));
      }
    } catch (failure) {
      if (!alive()) return;
      if (wrote) {
        generation.current++;
        const conflict = failure?.code === 'whiteboard/catalog-conflict';
        setNotice(conflict ? '白板目录已被其他窗口修改，已重新获取；请检查后再操作。' : '操作结果未知，已尝试刷新目录；请检查白板列表，不会自动重复提交。');
        if (action === 'create') { setForm(null); setName(''); }
        await refresh({ reconcile: true });
      } else setNotice(failure.message);
    } finally {
      pendingRef.current = false;
      if (alive()) setPending(false);
    }
  }

  if (closed || signal?.aborted) return null;
  if (!catalog || !selected) return <div className="dsh-wb-navigation" aria-busy={loading}>
    <p role={error ? 'alert' : 'status'}>{error || '正在加载白板目录…'}</p>
    <button type="button" disabled={loading} onClick={() => refresh()}>重试</button>
  </div>;

  const index = catalog.boards.findIndex(board => board.id === selected.id);
  const missing = index < 0;
  const query = search.trim().toLocaleLowerCase();
  const filtered = catalog.boards.filter(board => board.id === selected.id || `${board.name} ${board.id}`.toLocaleLowerCase().includes(query));
  const previous = index > 0 ? catalog.boards[index - 1] : null;
  const next = index >= 0 ? catalog.boards[index + 1] : null;
  const trimmedName = name.trim();
  function openForm(action, event) {
    if (pendingRef.current || !alive()) return;
    formInvoker.current = event?.currentTarget;
    setForm(action); setName(action === 'rename' ? selected.name : '');
  }
  function removeSelected() {
    if (pendingRef.current || missing || catalog.boards.length <= 1 || !alive()) return;
    if (window.confirm(`确定删除白板「${selected.name}」？删除后无法恢复。`)) void manage('delete', { boardId: selected.id });
  }
  function closeDeletedDraft() {
    const current = selectedRef.current;
    const confirmed = catalogRef.current;
    if (!alive() || pendingRef.current || !current || confirmed.boards.some(board => board.id === current.id)) return;
    if (!window.confirm(`关闭已删除白板「${current.name}」？请先导出未保存内容，关闭后不再显示此草稿；浏览器恢复备份不保证可用。`)) return;
    // This exceptional, explicitly confirmed close is not a save/force-switch:
    // the server has already removed the board, so its draft cannot be saved.
    const latest = catalogRef.current;
    if (!alive() || selectedRef.current !== current || latest.boards.some(board => board.id === current.id)) return;
    choose(latest.boards.find(board => board.id === latest.activeBoardId));
    setForm(null);
    setNotice('已关闭已删除白板的本地草稿。');
  }
  const alerts = pending || missing || notice || error ? <>
    {pending && <p role="status">正在保存并处理白板操作，请稍候…</p>}
    {missing && <p role="alert">当前白板已被删除；为避免丢失修改，草稿仍保留在编辑器中。请先导出未保存内容，再选择其他白板或明确关闭此草稿。 <button type="button" disabled={pending} onClick={closeDeletedDraft}>关闭已删除白板</button></p>}
    {notice && <p role="alert">{notice}</p>}
    {error && <p role="alert">{error} <button type="button" disabled={pending || loading} onClick={() => refresh()}>重试</button></p>}
  </> : null;
  const navigation = <div className="dsh-wb-navigation" aria-label="白板导航" aria-busy={pending}>
    <HeaderMenu id="boards" label="白板管理与切换" visible={visible} signal={requests.signal}
      title={`${selected.name} · 共 ${catalog.boards.length} 张白板，点击管理和切换`}
      summary={<><span className="dsh-wb-board-name">✎ {selected.name}</span><small>{catalog.boards.length}</small><span aria-hidden="true">⌄</span></>}
      onClose={() => { setForm(null); setName(''); }}>
    <div className="dsh-wb-navigation__switcher">
      <input type="search" aria-label="搜索白板" placeholder="搜索名称或 ID" value={search} onChange={event => setSearch(event.target.value)} />
      <button type="button" aria-label="上一张白板" title={previous ? `上一张 ${index}/${catalog.boards.length}：${previous.name}` : '已是第一张白板'} disabled={pending || !previous} onClick={() => manage('activate', { boardId: previous.id })}>上一张</button>
      <select aria-label="切换白板" value={selected.id} disabled={pending} onChange={event => manage('activate', { boardId: event.target.value })}>
        {missing && <option value={selected.id}>{selected.name}（已删除，保留草稿）</option>}
        {filtered.map(board => <option key={board.id} value={board.id}>{board.name}</option>)}
      </select>
      <button type="button" aria-label="下一张白板" title={next ? `下一张 ${index + 2}/${catalog.boards.length}：${next.name}` : '已是最后一张白板'} disabled={pending || !next} onClick={() => manage('activate', { boardId: next.id })}>下一张</button>
    </div>
    <div className="dsh-wb-navigation__actions">
      <button type="button" disabled={pending} onClick={event => openForm('create', event)}>新建白板</button>
      <button type="button" disabled={pending || missing} onClick={event => openForm('rename', event)}>重命名白板</button>
      <button type="button" disabled={pending || missing || catalog.boards.length <= 1} onClick={removeSelected}>删除白板</button>
      <button type="button" disabled={pending || loading} onClick={() => refresh()}>刷新列表</button>
    </div>
    {form && <form aria-label={form === 'create' ? '新建白板' : '重命名白板'} onSubmit={event => {
      event.preventDefault();
      if (trimmedName && trimmedName.length <= 80) void manage(form, { ...(form === 'rename' ? { boardId: selected.id } : {}), name: trimmedName });
    }}>
      <label>白板名称 <input aria-label="白板名称" value={name} maxLength={80} autoFocus disabled={pending} onChange={event => setName(event.target.value)} /></label>
      <button type="submit" disabled={pending || !trimmedName || trimmedName.length > 80}>确认</button>
      <button type="button" disabled={pending} onClick={() => { restoreFormFocus.current = true; setForm(null); setName(''); }}>取消</button>
    </form>}
    </HeaderMenu>
  </div>;
  return <Whiteboard key={JSON.stringify([sessionId, selected.id])} sessionId={sessionId} boardId={selected.id} boardName={selected.name} rpc={rpc} visible={visible} blocked={pending} signal={requests.signal} navigation={navigation} navigationNotice={alerts} registerLeaveGuard={registerLeaveGuard} />;
}
