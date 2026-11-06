import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { applyOperations, emptyBoard, MAX_SCENE_BYTES, validateOperations, validateScene, validateSessionId } from './model.mjs';

const MAX_DISK_BYTES = MAX_SCENE_BYTES + 16 * 1024;
// Also serialize multiple BoardStore instances in this process using the same directory.
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

/** A per-session serialized, revisioned JSON store. No in-memory scene cache is authoritative. */
export class BoardStore {
  constructor({ directory } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw failure('validation', 'directory must be a nonempty path');
    this.directory = path.resolve(directory);
    this.closed = false;
    this.pending = new Set();
  }

  filename(sessionId) {
    validateSessionId(sessionId);
    const name = `${createHash('sha256').update(sessionId, 'utf8').digest('hex')}.json`;
    const filename = path.join(this.directory, name);
    if (path.dirname(filename) !== this.directory) throw failure('validation', 'Unsafe session path');
    return filename;
  }

  serial(sessionId, work) {
    if (this.closed) return Promise.reject(failure('disposed', 'BoardStore has been disposed'));
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

  async read(sessionId, filename) {
    let handle;
    try {
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyBoard(sessionId);
      if (error.code === 'ELOOP') throw failure('corrupt', 'Board file must not be a symbolic link', error);
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_DISK_BYTES) throw failure('corrupt', 'Board file is not a regular file or exceeds the disk size limit');
      const chunks = [];
      let total = 0;
      // Never let a growing or malicious file cause an unbounded read allocation.
      while (total <= MAX_DISK_BYTES) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_DISK_BYTES + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (!bytesRead) break;
        total += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      if (total > MAX_DISK_BYTES) throw failure('corrupt', 'Board file exceeds the disk size limit');
      let board;
      try {
        board = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
        if (!board || typeof board !== 'object' || Array.isArray(board) || board.sessionId !== sessionId) throw new Error('Invalid stored sessionId');
        revision(board.revision);
        if (typeof board.updatedAt !== 'string' || !Number.isFinite(Date.parse(board.updatedAt))) throw new Error('Invalid stored updatedAt');
        if (Object.keys(board).some((key) => !['sessionId', 'revision', 'elements', 'files', 'selectedIds', 'updatedAt'].includes(key))) throw new Error('Unexpected stored board fields');
        const scene = validateScene({ elements: board.elements, files: board.files, selectedIds: board.selectedIds });
        board = { sessionId, revision: board.revision, ...scene, updatedAt: board.updatedAt };
      } catch (error) {
        throw failure('corrupt', 'Board file is corrupt; refusing to overwrite it', error);
      }
      return board;
    } finally {
      await handle.close();
    }
  }

  async persist(filename, board) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
    // Both the destination and cleanup target must stay in this exact store directory.
    if (path.dirname(temporary) !== this.directory || path.dirname(filename) !== this.directory) throw failure('validation', 'Unsafe atomic write path');
    const data = JSON.stringify(board);
    if (Buffer.byteLength(data) > MAX_DISK_BYTES) throw failure('validation', 'Board exceeds the disk size limit');
    let handle;
    let created = false;
    try {
      handle = await open(temporary, 'wx', 0o600);
      created = true;
      await handle.writeFile(data, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, filename);
      created = false;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created) await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  compare(current, baseRevision) {
    revision(baseRevision);
    if (current.revision !== baseRevision) {
      const error = failure('conflict', `Revision conflict: expected ${baseRevision}, current ${current.revision}`);
      error.board = clone(current);
      throw error;
    }
    if (current.revision === Number.MAX_SAFE_INTEGER) throw failure('validation', 'Revision limit reached');
  }

  async get(sessionId) {
    return this.serial(sessionId, async (filename) => clone(await this.read(sessionId, filename)));
  }

  async save(sessionId, baseRevision, scene) {
    // Capture and validate immediately so callers cannot mutate queued input while waiting.
    validateSessionId(sessionId);
    revision(baseRevision);
    const detached = validateScene(scene);
    return this.serial(sessionId, async (filename) => {
      const current = await this.read(sessionId, filename);
      this.compare(current, baseRevision);
      const incoming = new Map(detached.elements.map((element) => [element.id, element]));
      for (const prior of current.elements) {
        const next = incoming.get(prior.id);
        if (next) {
          if (next.type !== prior.type || (prior.seed !== undefined && next.seed !== prior.seed)) throw failure('validation', `Element identity is immutable: ${prior.id}`);
          // Native undo restores the same identity, not a new AI element with a reused ID.
          if (prior.isDeleted && !next.isDeleted && (!Number.isSafeInteger(next.version) || next.version <= (prior.version ?? 0))) throw failure('validation', `Restoring a deleted element requires a newer native version: ${prior.id}`);
        } else {
          // Native clients may omit deleted elements. Keep their IDs reserved forever.
          const tombstone = clone(prior);
          if (!tombstone.isDeleted) {
            tombstone.isDeleted = true;
            tombstone.version = (tombstone.version ?? 0) + 1;
            tombstone.versionNonce = randomInt(1, 2147483647);
            tombstone.updated = Date.now();
            tombstone.boundElements = null;
            if (tombstone.type === 'arrow') { tombstone.startBinding = null; tombstone.endBinding = null; }
            if (tombstone.type === 'text') tombstone.containerId = null;
          }
          detached.elements.push(tombstone);
        }
      }
      const clean = validateScene(detached);
      const next = { sessionId, revision: current.revision + 1, ...clean, updatedAt: new Date().toISOString() };
      await this.persist(filename, next);
      return clone(next);
    });
  }

  async patch(sessionId, baseRevision, operations) {
    validateSessionId(sessionId);
    revision(baseRevision);
    const detached = validateOperations(operations);
    return this.serial(sessionId, async (filename) => {
      const current = await this.read(sessionId, filename);
      this.compare(current, baseRevision);
      const next = applyOperations(current, detached);
      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();
      await this.persist(filename, next);
      return clone(next);
    });
  }

  async dispose() {
    this.closed = true;
    await Promise.all([...this.pending]);
  }
}
