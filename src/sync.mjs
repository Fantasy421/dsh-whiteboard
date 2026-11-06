export function sceneOf(board) {
  return { elements: board.elements ?? [], files: board.files ?? {}, selectedIds: board.selectedIds ?? [] };
}
const equal = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
};
export function mergeScenes(base, local, remote) {
  const conflicts = [];
  function mergeMap(before, mine, theirs, label) {
    const result = {};
    for (const id of new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(before)])) {
      const a = before[id], b = mine[id], c = theirs[id];
      if (equal(a, b)) { if (c !== undefined) result[id] = c; }
      else if (equal(a, c) || equal(b, c)) { if (b !== undefined) result[id] = b; }
      else conflicts.push(`${label}:${id}`);
    }
    return result;
  }
  const byId = es => Object.fromEntries(es.map(e => [e.id, e]));
  const elements = Object.values(mergeMap(byId(base.elements), byId(local.elements), byId(remote.elements), 'element'));
  // Excalidraw stores z-order twice: array order and fractional indices. Merging maps
  // must not let the remote insertion order silently undo a local bring-to-front.
  if (elements.every(e => typeof e.index === 'string' && e.index.length)) {
    elements.sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  } else {
    // Legacy scenes without indices: preserve the one side that reordered common
    // existing IDs; incompatible concurrent reorders require explicit resolution.
    const common = new Set(base.elements.map(e => e.id).filter(id => local.elements.some(e => e.id === id) && remote.elements.some(e => e.id === id)));
    const order = es => es.map(e => e.id).filter(id => common.has(id));
    const before = order(base.elements), mine = order(local.elements), theirs = order(remote.elements);
    const mineMoved = !equal(before, mine), theirsMoved = !equal(before, theirs);
    if (mineMoved && theirsMoved && !equal(mine, theirs)) conflicts.push('order:elements');
    const preferred = mineMoved ? local.elements : remote.elements;
    const rank = new Map([...preferred, ...elements].map(e => e.id).filter((id, i, ids) => ids.indexOf(id) === i).map((id, i) => [id, i]));
    elements.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  }
  const files = mergeMap(base.files, local.files, remote.files, 'file');
  // Bindings are graph edges. Editing a label/arrow while deleting its target is a conflict too.
  const live = new Map(elements.filter(e => !e.isDeleted).map(e => [e.id, e]));
  for (const e of live.values()) {
    for (const id of [e.containerId, e.frameId, e.startBinding?.elementId, e.endBinding?.elementId, ...(e.boundElements ?? []).map(b => b.id)]) {
      if (id && !live.has(id)) conflicts.push(`binding:${e.id}:${id}`);
    }
  }
  if (conflicts.length) {
    const error = new Error(`同一对象被同时修改：${conflicts.slice(0, 5).join(', ')}`);
    error.code = 'conflict'; throw error;
  }
  return { elements, files, selectedIds: local.selectedIds.filter(id => live.has(id)) };
}

/** One owner per mounted session whiteboard. Writes serialize, and never overwrite a stale revision. */
export class BoardSync {
  constructor({ read, write, onScene, onStatus = () => {}, recovery, normalize = scene => scene }) {
    Object.assign(this, { read, write, onScene, onStatus, recovery, normalize });
    this.base = null; this.baseScene = null; this.local = null; this.disposed = false; this.paused = false;
  }
  get dirty() { return this.base && !equal(this.baseScene, this.local); }
  async start() {
    const remote = await this.read();
    if (this.disposed) return;
    this.base = remote; this.baseScene = this.normalize(sceneOf(remote)); this.local = this.baseScene;
    let recovered;
    try { recovered = this.recovery?.load(); } catch { /* Recovery storage may be disabled. */ }
    if (recovered) {
      try { this.local = mergeScenes(this.normalize(sceneOf(recovered.base)), this.normalize(recovered.local), this.baseScene); }
      catch {
        this.local = recovered.local; this.paused = true;
        this.onStatus('conflict', '检测到未保存的本地修改；请先下载源文件备份，再决定是否加载服务器版本。');
      }
    }
    this.onScene(this.local, { initial: true });
    if (!this.paused) this.onStatus(this.dirty ? 'dirty' : 'saved');
  }
  observe(scene) {
    if (this.disposed || !this.base || equal(scene, this.local)) return;
    this.local = structuredClone(scene);
    this.backup();
    if (!this.paused) this.onStatus('dirty');
  }
  backup() {
    try {
      if (this.dirty) this.recovery?.save({ base: { ...this.base, ...this.baseScene }, local: this.local });
      else this.recovery?.clear();
    } catch { this.onStatus('warning', '浏览器本地备份不可用，请及时导出源文件；服务器保存仍会重试。'); }
  }
  integrate(remote) {
    const incoming = this.normalize(sceneOf(remote));
    const merged = mergeScenes(this.baseScene, this.local, incoming);
    const changed = !equal(this.local, merged);
    this.base = remote; this.baseScene = incoming; this.local = merged;
    this.backup();
    if (changed) this.onScene(merged, { initial: false });
  }
  tick() {
    if (this.disposed || this.paused || !this.base) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = this.run().finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async run() {
    try {
      if (this.dirty) {
        this.onStatus('saving');
        const submitted = structuredClone(this.local);
        const remote = await this.write(this.base.revision, submitted);
        if (this.disposed) return;
        // Edits made during an in-flight save are based on the submitted scene,
        // not the old server baseline. They must remain dirty, not conflict with our own save.
        const incoming = this.normalize(sceneOf(remote));
        const merged = mergeScenes(submitted, this.local, incoming);
        const changed = !equal(this.local, merged);
        this.base = remote; this.baseScene = incoming; this.local = merged; this.backup();
        if (changed) this.onScene(merged, { initial: false });
      } else {
        const remote = await this.read();
        if (this.disposed) return;
        if (remote.revision !== this.base.revision) this.integrate(remote);
      }
      this.onStatus(this.dirty ? 'dirty' : 'saved');
    } catch (error) {
      if (this.disposed) return;
      const remote = error.board ?? error.details?.board;
      if (remote) {
        try {
          this.integrate(remote);
          this.onStatus('dirty'); // Re-evaluate and write on next tick, not a blind stale retry.
          return;
        } catch (mergeError) { error = mergeError; }
      }
      if (error.code === 'conflict' || error.code === 'whiteboard/conflict') {
        this.paused = true; this.backup(); this.onStatus('conflict', error.message);
      } else this.onStatus('offline', error.message ?? '保存失败；保留本地修改，自动重试。');
    }
  }
  async discardLocalAndReload() {
    if (this.inflight) await this.inflight;
    const remote = await this.read();
    if (this.disposed) return;
    this.base = remote; this.baseScene = this.normalize(sceneOf(remote)); this.local = this.baseScene; this.paused = false;
    this.backup(); this.onScene(this.local, { initial: true }); this.onStatus('saved');
  }
  dispose() { this.backup(); this.disposed = true; }
}
