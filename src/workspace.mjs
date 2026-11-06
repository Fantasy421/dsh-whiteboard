import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { BoardStore } from './store.mjs';
import { validateOperations, validateScene, validateSessionId } from './model.mjs';

const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_BOARDS = 100;
const MAX_ENTRIES = 1000;
const BOARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// The lock covers metadata checks AND the full scene operation, across instances.
const queues = new Map();
const clone = (value) => structuredClone(value);

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('validation', 'baseRevision must be a nonnegative safe integer');
}

function boardId(value) {
  if (typeof value !== 'string' || (value !== 'default' && !BOARD_ID.test(value))) throw failure('validation', 'boardId must be default or a lowercase UUID');
  return value;
}

function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) throw failure('validation', 'name must be nonempty, at most 80 characters, and contain no controls');
  return value.trim();
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure('validation', 'Expected a plain object');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure('validation', 'Unexpected field or accessor');
  }
}

function options(action, input) {
  exactObject(input, ['boardId', 'name']);
  const result = {};
  for (const key of Object.keys(input)) result[key] = input[key];
  if (action === 'create') {
    if (Object.hasOwn(result, 'boardId')) throw failure('validation', 'create generates its own boardId');
    if (Object.hasOwn(result, 'name')) result.name = name(result.name);
  } else {
    result.boardId = boardId(result.boardId);
    if (action === 'rename') result.name = name(result.name);
    else if (Object.hasOwn(result, 'name')) throw failure('validation', 'name is only accepted by create and rename');
  }
  return result;
}

function virtualCatalog(sessionId) {
  return { sessionId, revision: 0, activeBoardId: 'default', boards: [{ id: 'default', name: '白板 1', deleted: false }] };
}

function snapshot(catalog) {
  return { sessionId: catalog.sessionId, revision: catalog.revision, activeBoardId: catalog.activeBoardId,
    boards: catalog.boards.filter((entry) => !entry.deleted).map(({ id, name }) => ({ id, name })) };
}

function validateCatalog(value, sessionId) {
  exactObject(value, ['sessionId', 'revision', 'activeBoardId', 'boards']);
  if (Object.keys(value).length !== 4 || value.sessionId !== sessionId) throw failure('validation', 'Invalid catalog identity or fields');
  revision(value.revision);
  boardId(value.activeBoardId);
  if (!Array.isArray(value.boards) || !value.boards.length || value.boards.length > MAX_ENTRIES) throw failure('validation', 'Invalid catalog entry count');
  const seen = new Set();
  let live = 0;
  for (const entry of value.boards) {
    exactObject(entry, ['id', 'name', 'deleted']);
    if (Object.keys(entry).length !== 3 || typeof entry.deleted !== 'boolean' || name(entry.name) !== entry.name) throw failure('validation', 'Invalid catalog entry');
    boardId(entry.id);
    if (seen.has(entry.id)) throw failure('validation', 'Duplicate catalog boardId');
    seen.add(entry.id);
    if (!entry.deleted) live++;
  }
  if (!seen.has('default') || !live || live > MAX_BOARDS || !value.boards.some((entry) => entry.id === value.activeBoardId && !entry.deleted)) throw failure('validation', 'Invalid live boards or active board');
  return value;
}

// Check controlled directories before either reads or recursive BoardStore writes.
// Reads do not create any directory; symlinks, including dangling ones, are refused.
async function directories(paths, create = false) {
  for (const directory of paths) {
    let info;
    try { info = await lstat(directory); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      info = await lstat(directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('corrupt', 'Workspace path must be a real directory, not a symbolic link');
  }
  return true;
}

/** Multi-board catalog wrapper; the legacy BoardStore contract and files stay unchanged. */
export class WorkspaceStore {
  constructor({ directory } = {}) {
    this.legacyStore = new BoardStore({ directory });
    this.directory = this.legacyStore.directory;
    this.catalogDirectory = path.join(this.directory, 'catalogs');
    this.catalogWriter = new BoardStore({ directory: this.catalogDirectory });
    this.closed = false;
    this.pending = new Set();
  }

  filename(sessionId) {
    validateSessionId(sessionId);
    return this.catalogWriter.filename(sessionId);
  }

  serial(sessionId, work) {
    if (this.closed) return Promise.reject(failure('disposed', 'WorkspaceStore has been disposed'));
    let filename;
    try { filename = this.filename(sessionId); } catch (error) { return Promise.reject(error); }
    const previous = queues.get(filename) ?? Promise.resolve();
    const result = previous.then(() => work(filename));
    const barrier = result.then(() => undefined, () => undefined);
    queues.set(filename, barrier);
    this.pending.add(barrier);
    barrier.then(() => {
      this.pending.delete(barrier);
      if (queues.get(filename) === barrier) queues.delete(filename);
    });
    return result;
  }

  async readCatalog(sessionId, filename) {
    if (!await directories([this.directory, this.catalogDirectory])) return virtualCatalog(sessionId);
    let handle;
    try { handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if (error.code === 'ENOENT') return virtualCatalog(sessionId);
      if (error.code === 'ELOOP') throw failure('corrupt', 'Catalog must not be a symbolic link', error);
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) throw failure('corrupt', 'Catalog is not a regular file or exceeds the disk size limit');
      const chunks = [];
      let total = 0;
      while (total <= MAX_CATALOG_BYTES) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_CATALOG_BYTES + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (!bytesRead) break;
        total += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      if (total > MAX_CATALOG_BYTES) throw failure('corrupt', 'Catalog exceeds the disk size limit');
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
        return validateCatalog(value, sessionId);
      } catch (error) {
        throw failure('corrupt', 'Catalog is corrupt; refusing to overwrite it', error);
      }
    } finally { await handle.close(); }
  }

  async list(sessionId) {
    return this.serial(sessionId, async (filename) => snapshot(await this.readCatalog(sessionId, filename)));
  }

  async manage(sessionId, baseRevision, action, input = {}) {
    validateSessionId(sessionId);
    revision(baseRevision);
    if (!['create', 'rename', 'delete', 'activate'].includes(action)) throw failure('validation', 'Unknown catalog action');
    // Capture/validate options synchronously, before joining a possibly blocked queue.
    const detached = options(action, input);
    return this.serial(sessionId, async (filename) => {
      const catalog = await this.readCatalog(sessionId, filename);
      if (catalog.revision !== baseRevision) {
        const error = failure('catalog-conflict', `Catalog revision conflict: expected ${baseRevision}, current ${catalog.revision}`);
        error.catalog = snapshot(catalog);
        throw error;
      }
      if (catalog.revision === Number.MAX_SAFE_INTEGER) throw failure('validation', 'Catalog revision limit reached');
      const live = catalog.boards.filter((entry) => !entry.deleted);
      if (action === 'create') {
        if (live.length >= MAX_BOARDS || catalog.boards.length >= MAX_ENTRIES) throw failure('validation', 'Catalog board limit reached');
        let id;
        do { id = randomUUID(); } while (catalog.boards.some((entry) => entry.id === id));
        catalog.boards.push({ id, name: detached.name ?? `白板 ${live.length + 1}`, deleted: false });
        catalog.activeBoardId = id;
      } else {
        const entry = live.find((entry) => entry.id === detached.boardId);
        if (!entry) throw failure('not-found', 'Whiteboard does not exist or has been deleted');
        if (action === 'rename') entry.name = detached.name;
        if (action === 'activate') catalog.activeBoardId = entry.id;
        if (action === 'delete') {
          if (live.length === 1) throw failure('validation', 'Cannot delete the last whiteboard');
          entry.deleted = true;
          if (catalog.activeBoardId === entry.id) catalog.activeBoardId = live.find((other) => other.id !== entry.id).id;
        }
      }
      catalog.revision++;
      validateCatalog(catalog, sessionId);
      if (Buffer.byteLength(JSON.stringify(catalog)) > MAX_CATALOG_BYTES) throw failure('validation', 'Catalog exceeds the disk size limit');
      await directories([this.directory, this.catalogDirectory], true);
      await this.catalogWriter.persist(filename, catalog);
      return snapshot(catalog);
    });
  }

  resolveBoard(catalog, requested, writing) {
    const live = catalog.boards.filter((entry) => !entry.deleted);
    if (requested === undefined && writing && live.length !== 1) throw failure('validation', 'Explicit boardId is required when multiple whiteboards exist');
    const id = requested ?? catalog.activeBoardId;
    if (!live.some((entry) => entry.id === id)) throw failure('not-found', 'Whiteboard does not exist or has been deleted');
    return id;
  }

  async sceneOperation(sessionId, requested, writing, operation) {
    return this.serial(sessionId, async (filename) => {
      const catalog = await this.readCatalog(sessionId, filename);
      const id = this.resolveBoard(catalog, requested, writing);
      const paths = [this.directory];
      if (id !== 'default') {
        paths.push(path.join(this.directory, 'boards'));
        paths.push(path.join(paths.at(-1), createHash('sha256').update(sessionId, 'utf8').digest('hex')));
        paths.push(path.join(paths.at(-1), id));
      }
      await directories(paths, writing);
      const store = id === 'default' ? this.legacyStore : new BoardStore({ directory: paths.at(-1) });
      try {
        return { ...await operation(store), boardId: id };
      } catch (error) {
        if (error.code === 'conflict' && error.board) error.board = { ...error.board, boardId: id };
        throw error;
      } finally {
        if (store !== this.legacyStore) await store.dispose();
      }
    });
  }

  async get(sessionId, requested) {
    validateSessionId(sessionId);
    if (requested !== undefined) boardId(requested);
    return this.sceneOperation(sessionId, requested, false, (store) => store.get(sessionId));
  }

  async save(sessionId, baseRevision, scene, requested) {
    validateSessionId(sessionId);
    revision(baseRevision);
    if (requested !== undefined) boardId(requested);
    const detached = validateScene(scene);
    return this.sceneOperation(sessionId, requested, true, (store) => store.save(sessionId, baseRevision, detached));
  }

  async patch(sessionId, baseRevision, operations, requested) {
    validateSessionId(sessionId);
    revision(baseRevision);
    if (requested !== undefined) boardId(requested);
    const detached = validateOperations(operations);
    return this.sceneOperation(sessionId, requested, true, (store) => store.patch(sessionId, baseRevision, detached));
  }

  async dispose() {
    this.closed = true;
    await Promise.all([...this.pending]);
    await Promise.all([this.legacyStore.dispose(), this.catalogWriter.dispose()]);
  }
}
