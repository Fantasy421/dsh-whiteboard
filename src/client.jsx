import React from 'react';
import excalidrawCss from '@excalidraw/excalidraw/index.css';
import whiteboardCss from './style.css';
import { Whiteboard } from './Whiteboard.jsx';
export const name = 'dsh-whiteboard';
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'connection'];

export function apply(ctx) {
  const style = document.createElement('style');
  style.dataset.dshWhiteboard = 'true';
  style.textContent = excalidrawCss.replace(/url\((["']?)(?:\.\/)?fonts\//g, (_match, quote) => `url(${quote}/api/dsh-whiteboard-assets/fonts/`) + '\n' + whiteboardCss;
  window.EXCALIDRAW_ASSET_PATH = '/api/dsh-whiteboard-assets/';
  ctx.effect(() => { document.head.append(style); return () => style.remove(); });
  const rpc = async (method, payload) => {
    const result = await ctx.connection.rpc.call('/api', 'dsh-whiteboard', { method, payload });
    if (!result.ok) {
      const error = new Error(result.error.message);
      error.code = result.error.code; error.details = result.error.details;
      throw error;
    }
    return result.value;
  };
  function Body({ sessionId, useTabInfo }) {
    const { tab } = useTabInfo();
    return <Whiteboard key={sessionId} sessionId={sessionId} rpc={rpc} visible={tab.visible} signal={tab.signal} />;
  }
  function Title() { return '协作白板'; }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'dsh-whiteboard', kind: 'whiteboard', priority: 'extension', title: () => '协作白板',
    guide: [{ id: 'whiteboard', order: 50, title: () => '协作白板', description: () => '和 AI 一起画流程图、框图、自由写字' }],
  }));
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-whiteboard' }, Body)));
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'dsh-whiteboard' }, Title)));
}
