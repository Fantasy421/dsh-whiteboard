const MAX_BODY_BYTES = 9 * 1024 * 1024;
export const ENDPOINT = 'dsh-whiteboard';

export function createRpcHandler(store) {
  return async (request) => {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      return new Response('Expected application/json', { status: 415 });
    }
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return new Response('Request too large', { status: 413 });
    let message;
    try { message = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const reply = (result) => Response.json({ type: 'server-response', rpcId: message?.rpcId ?? 'invalid', result });
    try {
      if (message?.type !== 'client-request' || message.method !== ENDPOINT || typeof message.rpcId !== 'string') {
        throw new Error('Invalid request envelope');
      }
      const { method, payload } = message.payload ?? {};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid payload');
      const { sessionId } = payload;
      let board;
      if (method === 'get') board = await store.get(sessionId);
      else if (method === 'save') board = await store.save(sessionId, payload.baseRevision, payload.scene);
      else throw new Error('Unknown whiteboard operation');
      return reply({ ok: true, value: board });
    } catch (error) {
      return reply({ ok: false, error: {
        code: error.code === 'conflict' ? 'whiteboard/conflict' : 'whiteboard/request-failed',
        message: error.message,
        details: error.board ? { board: error.board } : {},
      } });
    }
  };
}
