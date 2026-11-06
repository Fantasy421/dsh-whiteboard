import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// One active disclosure per board, without remounting the editor below it.
export const HeaderMenuContext = createContext(null);

export function HeaderMenu({ id, label, summary, title, children, visible = true, signal, onClose, className = '' }) {
  const shared = useContext(HeaderMenuContext);
  const [local, setLocal] = useState(null);
  const active = shared ? shared.active : local;
  const setActive = shared ? shared.setActive : setLocal;
  const open = active === id;
  const panelId = useId(), keyboardOpen = useRef(false);
  const ref = useRef(null), panelRef = useRef(null), summaryRef = useRef(null), wasOpen = useRef(false);
  const close = () => {
    if (visible && !signal?.aborted && typeof document !== 'undefined' && (ref.current?.contains(document.activeElement) || panelRef.current?.contains(document.activeElement))) summaryRef.current?.focus({ preventScroll: true });
    setActive(previous => previous === id ? null : previous);
  };
  useEffect(() => {
    shared?.summaries.current.set(id, summaryRef.current);
    return () => { shared?.summaries.current.delete(id); };
  }, [id, shared?.summaries]);
  useEffect(() => {
    if (wasOpen.current && !open) onClose?.();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!visible || signal?.aborted) close();
    const abort = () => close();
    signal?.addEventListener('abort', abort, { once: true });
    return () => signal?.removeEventListener('abort', abort);
  }, [visible, signal, setActive, id]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!ref.current?.contains(event.target) && !panelRef.current?.contains(event.target)) close(); };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open, setActive, id]);
  useEffect(() => {
    if (open && keyboardOpen.current) {
      keyboardOpen.current = false;
      const first = panelRef.current?.querySelector?.('input:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex="0"]');
      (first ?? panelRef.current)?.focus({ preventScroll: true });
    }
  }, [open, shared?.panelRoot]);
  const panel = open ? <div ref={panelRef} id={panelId} tabIndex={-1} role="region" aria-label={label} className="dsh-wb-menu-panel" data-dsh-wb-panel={id}>{children}</div> : null;
  return <>
    <details ref={ref} data-dsh-wb-menu={id} className={`dsh-wb-menu ${className}`} open={open}
      onKeyDown={event => {
        if (open && event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
          event.preventDefault(); event.stopPropagation(); close(); summaryRef.current?.focus({ preventScroll: true });
        }
      }}>
      <summary ref={summaryRef} aria-label={label} aria-controls={open ? panelId : undefined} aria-expanded={open} title={title} onClick={event => {
        // React alone owns the toggle: asynchronous native toggle events cannot
        // reopen an old/hidden menu or close a newly selected sibling menu.
        event.preventDefault();
        if (!visible || signal?.aborted) return;
        if (open) close(); else { keyboardOpen.current = event.detail === 0; setActive(id); }
      }}>{summary}</summary>
      {panel && (shared?.panelRoot ? createPortal(panel, shared.panelRoot) : panel)}
    </details>
  </>;
}
