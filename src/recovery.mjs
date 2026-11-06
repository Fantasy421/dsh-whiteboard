/** Each board owns its recovery; retain the original key only for the legacy board. */
export function recoveryFor(sessionId, boardId = 'default', storage = localStorage) {
  const key = boardId === 'default'
    ? `dsh-whiteboard:recovery:${sessionId}`
    : `dsh-whiteboard:recovery-v2:${JSON.stringify([sessionId, boardId])}`;
  return {
    load() {
      const value = JSON.parse(storage.getItem(key) ?? 'null');
      if (value && (value.base?.sessionId !== sessionId || (value.base?.boardId ?? 'default') !== boardId)) {
        throw new Error('Recovery belongs to a different whiteboard');
      }
      return value;
    },
    save: value => storage.setItem(key, JSON.stringify(value)),
    clear: () => storage.removeItem(key),
  };
}
