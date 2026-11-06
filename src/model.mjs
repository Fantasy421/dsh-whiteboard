import { randomInt } from 'node:crypto';

export const MAX_SCENE_BYTES = 8 * 1024 * 1024;
export const MAX_ELEMENTS = 2000;
const TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'arrow', 'line', 'freedraw', 'image', 'frame']);
const OP_TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'arrow', 'line']);
const CONTAINERS = new Set(['rectangle', 'diamond', 'ellipse', 'arrow']);
const BINDABLE = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'image', 'frame']);
const POISON = new Set(['__proto__', 'prototype', 'constructor']);
const OP_KEYS = new Set(['op', 'id', 'type', 'x', 'y', 'width', 'height', 'text', 'strokeColor', 'backgroundColor', 'fontSize', 'startId', 'endId', 'points']);
const NUMERIC = ['x', 'y', 'width', 'height', 'angle', 'strokeWidth', 'roughness', 'opacity', 'seed', 'version', 'versionNonce', 'updated', 'fontSize', 'fontFamily', 'lineHeight'];

function invalid(message) {
  const error = new Error(message);
  error.code = 'validation';
  throw error;
}

export function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) invalid('sessionId must be a nonempty string of at most 256 characters');
  return sessionId;
}

function id(value, name = 'id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || POISON.has(value) || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${name} must be a safe nonempty string of at most 256 characters`);
}

function finite(value, name, limit = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) invalid(`${name} must be a finite number within ±${limit}`);
}

// Reject non-JSON values before cloning: JSON.stringify alone silently drops unsafe values.
function jsonClone(value, limit = MAX_SCENE_BYTES) {
  let nodes = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    if (++nodes > 500000 || depth > 64) invalid('Scene data is too complex');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid('Scene contains a non-finite number');
      return;
    }
    if (typeof item === 'string') {
      if (Buffer.byteLength(item) > limit) invalid('Scene exceeds the 8MB JSON limit');
      return;
    }
    if (typeof item !== 'object') invalid('Scene must contain only JSON data');
    if (ancestors.has(item)) invalid('Scene contains cyclic data');
    const prototype = Object.getPrototypeOf(item);
    if ((!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) || (Array.isArray(item) && prototype !== Array.prototype)) invalid('Scene contains an unsafe object prototype');
    if (Object.getOwnPropertySymbols(item).length) invalid('Scene contains symbol keys');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of Object.keys(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (POISON.has(key)) invalid(`Unsafe property: ${key}`);
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor)) invalid('Scene contains accessors or hidden properties');
      if (Array.isArray(item) && (!/^\d+$/u.test(key) || Number(key) >= item.length)) invalid('Scene contains non-JSON array properties');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(item) && Object.keys(item).length !== item.length) invalid('Scene contains a sparse array');
    ancestors.delete(item);
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limit) invalid('Scene exceeds the 8MB JSON limit');
  return JSON.parse(json);
}

function points(value, name) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20000) invalid(`${name} must contain 2 to 20000 points`);
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) invalid(`${name} points must be [x,y] pairs`);
    finite(point[0], name);
    finite(point[1], name);
  }
}

function color(value, name) {
  if (typeof value !== 'string' || value.length > 64 || !/^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-]+\))$/iu.test(value)) invalid(`${name} must be a CSS color, not a URL or script`);
}

function validateFiles(files) {
  if (!files || Array.isArray(files) || typeof files !== 'object') invalid('files must be an object');
  for (const [key, file] of Object.entries(files)) {
    id(key, 'file id');
    if (!file || Array.isArray(file) || typeof file !== 'object') invalid('Invalid image file');
    if (file.id !== key) invalid('Image file id must match its map key');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType)) invalid('Only PNG, JPEG and WebP image files are allowed');
    if (typeof file.dataURL !== 'string') invalid('Image file requires an embedded data URL');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(file.dataURL);
    if (!match || match[1] !== file.mimeType || match[2].length % 4 !== 0) invalid('Invalid image data URL; external images are forbidden');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2]) invalid('Invalid image base64 encoding');
    const validHeader = file.mimeType === 'image/png'
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : file.mimeType === 'image/jpeg'
        ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!validHeader) invalid('Image content does not match its MIME type');
    for (const key of ['created', 'lastRetrieved', 'version']) if (file[key] !== undefined) finite(file[key], `file.${key}`);
  }
}

function binding(value, owner, byId) {
  if (value === undefined || value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid arrow binding');
  id(value.elementId, 'binding.elementId');
  const target = byId.get(value.elementId);
  if (!owner.isDeleted && (!target || target.isDeleted || !BINDABLE.has(target.type) || target.containerId)) invalid(`Dangling or invalid arrow binding: ${value.elementId}`);
  for (const key of ['focus', 'gap']) if (value[key] !== undefined) finite(value[key], `binding.${key}`);
  if (value.fixedPoint !== undefined && value.fixedPoint !== null) {
    if (!Array.isArray(value.fixedPoint) || value.fixedPoint.length !== 2) invalid('Invalid binding fixedPoint');
    value.fixedPoint.forEach((number) => finite(number, 'fixedPoint'));
  }
}

/** Validate and detach a JSON-safe native Excalidraw scene. */
export function validateScene(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) invalid('scene must be an object');
  const clean = jsonClone(scene);
  const elements = clean.elements;
  const files = clean.files ?? {};
  const selectedIds = clean.selectedIds ?? [];
  if (!Array.isArray(elements) || elements.length > MAX_ELEMENTS) invalid('elements must be an array with at most 2000 elements (including tombstones)');
  validateFiles(files);
  if (!Array.isArray(selectedIds)) invalid('selectedIds must be an array');
  const byId = new Map();
  for (const element of elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) invalid('Invalid element');
    id(element.id);
    if (byId.has(element.id)) invalid(`Duplicate element id: ${element.id}`);
    byId.set(element.id, element);
    if (!TYPES.has(element.type)) invalid(`Unsafe element type: ${element.type}`);
    for (const key of ['x', 'y', 'width', 'height']) finite(element[key], `element.${key}`, 1e9);
    if (element.width < 0 || element.height < 0) invalid('Element dimensions cannot be negative');
    for (const key of NUMERIC) if (element[key] !== undefined) finite(element[key], `element.${key}`);
    if (element.isDeleted !== undefined && typeof element.isDeleted !== 'boolean') invalid('isDeleted must be boolean');
    if (element.locked !== undefined && typeof element.locked !== 'boolean') invalid('locked must be boolean');
    if (element.version !== undefined && (!Number.isSafeInteger(element.version) || element.version < 1)) invalid('version must be a positive integer');
    if (element.opacity !== undefined && (element.opacity < 0 || element.opacity > 100)) invalid('opacity must be between 0 and 100');
    for (const key of ['strokeColor', 'backgroundColor']) if (element[key] !== undefined) color(element[key], key);
    if (element.link != null && (typeof element.link !== 'string' || !/^(?:https?:\/\/|mailto:)/iu.test(element.link))) invalid('Unsafe element link');
    if (element.groupIds !== undefined && (!Array.isArray(element.groupIds) || element.groupIds.some((entry) => typeof entry !== 'string'))) invalid('groupIds must be strings');
    if (element.fillStyle !== undefined && !['hachure', 'cross-hatch', 'solid', 'zigzag'].includes(element.fillStyle)) invalid('Invalid fillStyle');
    if (element.strokeStyle !== undefined && !['solid', 'dashed', 'dotted'].includes(element.strokeStyle)) invalid('Invalid strokeStyle');
    if (element.strokeWidth !== undefined && element.strokeWidth < 0) invalid('strokeWidth cannot be negative');
    if (element.roughness !== undefined && element.roughness < 0) invalid('roughness cannot be negative');
    if (element.roundness != null && (typeof element.roundness !== 'object' || Array.isArray(element.roundness) || ![1, 2, 3].includes(element.roundness.type))) invalid('Invalid native roundness');
    if (element.frameId != null) id(element.frameId, 'frameId');
    if (element.name != null && typeof element.name !== 'string') invalid('Element name must be text');
    if (element.type === 'text' && element.textAlign !== undefined && !['left', 'center', 'right'].includes(element.textAlign)) invalid('Invalid textAlign');
    if (element.type === 'text' && element.verticalAlign !== undefined && !['top', 'middle', 'bottom'].includes(element.verticalAlign)) invalid('Invalid verticalAlign');
    if (element.type === 'text' && element.autoResize !== undefined && typeof element.autoResize !== 'boolean') invalid('autoResize must be boolean');
    if (['arrow', 'line'].includes(element.type)) {
      for (const key of ['startArrowhead', 'endArrowhead']) if (element[key] != null && !['arrow', 'bar', 'dot', 'triangle', 'diamond', 'circle', 'circle_outline', 'triangle_outline', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many'].includes(element[key])) invalid('Invalid native arrowhead');
      if (element.elbowed !== undefined && typeof element.elbowed !== 'boolean') invalid('elbowed must be boolean');
    }
    if (element.index !== undefined && (typeof element.index !== 'string' || !/^[A-Za-z0-9]+$/u.test(element.index))) invalid('Invalid native element index');
    if (element.type === 'text') {
      if (typeof element.text !== 'string') invalid('Text element requires text');
      if (element.originalText !== undefined && typeof element.originalText !== 'string') invalid('originalText must be text');
      if (element.fontSize !== undefined && (element.fontSize <= 0 || element.fontSize > 1000)) invalid('fontSize must be between 0 and 1000');
      if (element.fontFamily !== undefined && ![1, 2, 3, 5, 6, 7, 8].includes(element.fontFamily)) invalid('Unsupported native fontFamily');
      if (element.lineHeight !== undefined && element.lineHeight <= 0) invalid('lineHeight must be positive');
    }
    if (['arrow', 'line'].includes(element.type)) points(element.points, 'element.points');
    if (element.type === 'freedraw') {
      if (!Array.isArray(element.points) || !element.points.length) invalid('Freedraw requires points');
      for (const point of element.points) {
        if (!Array.isArray(point) || point.length !== 2) invalid('Invalid freedraw point');
        point.forEach((number) => finite(number, 'freedraw point'));
      }
      if (element.pressures !== undefined && (!Array.isArray(element.pressures) || element.pressures.some((pressure) => typeof pressure !== 'number' || pressure < 0 || pressure > 1))) invalid('Invalid freedraw pressures');
    }
    if (element.type === 'image') {
      if (element.fileId != null) id(element.fileId, 'fileId');
      if (!element.isDeleted && (typeof element.fileId !== 'string' || !Object.hasOwn(files, element.fileId))) invalid('Image references a missing embedded file');
      if (element.scale !== undefined && (!Array.isArray(element.scale) || element.scale.length !== 2 || element.scale.some((number) => number !== 1 && number !== -1))) invalid('Invalid image scale');
      if (element.src !== undefined || element.dataURL !== undefined || element.url !== undefined) invalid('Images must use files, not external or inline element URLs');
    }
  }
  for (const element of elements) {
    if (element.frameId != null && !element.isDeleted) {
      const frame = byId.get(element.frameId);
      if (!frame || frame.isDeleted || frame.type !== 'frame' || element.type === 'frame') invalid('Dangling or invalid frame reference');
    }
    if (element.type === 'arrow') {
      binding(element.startBinding, element, byId);
      binding(element.endBinding, element, byId);
    } else if (element.startBinding != null || element.endBinding != null) invalid('Only arrows may have bindings');
    if (element.containerId != null) {
      id(element.containerId, 'containerId');
      const container = byId.get(element.containerId);
      if (element.type !== 'text' || (!element.isDeleted && (!container || container.isDeleted || !CONTAINERS.has(container.type)))) invalid('Dangling or invalid text container');
    }
    if (element.boundElements != null) {
      if (!Array.isArray(element.boundElements)) invalid('boundElements must be an array or null');
      const seen = new Set();
      for (const bound of element.boundElements) {
        if (!bound || typeof bound !== 'object') invalid('Invalid bound element');
        id(bound.id, 'bound element id');
        if (!['text', 'arrow'].includes(bound.type) || seen.has(bound.id)) invalid('Invalid or duplicate bound element');
        seen.add(bound.id);
        const target = byId.get(bound.id);
        if (!element.isDeleted && (!target || target.isDeleted || target.type !== bound.type)) invalid('Dangling bound element');
        if (!element.isDeleted && bound.type === 'text' && target.containerId !== element.id) invalid('Mismatched text binding');
        if (!element.isDeleted && bound.type === 'arrow' && target.startBinding?.elementId !== element.id && target.endBinding?.elementId !== element.id) invalid('Mismatched arrow binding');
      }
    }
  }
  const selected = new Set();
  for (const selectedId of selectedIds) {
    id(selectedId, 'selected id');
    if (selected.has(selectedId) || !byId.has(selectedId) || byId.get(selectedId).isDeleted) invalid('selectedIds contains a duplicate, missing or deleted id');
    selected.add(selectedId);
  }
  return { elements, files, selectedIds };
}

export function emptyBoard(sessionId) {
  validateSessionId(sessionId);
  return { sessionId, revision: 0, elements: [], files: {}, selectedIds: [], updatedAt: new Date().toISOString() };
}

function nonce() { return randomInt(1, 2147483647); }
function bump(element) {
  element.version = (element.version ?? 0) + 1;
  element.versionNonce = nonce();
  element.updated = Date.now();
}
function nextIndex(elements) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let number = elements.length;
  let digits = '';
  for (let place = 0; place < 3; place++) { digits = alphabet[number % 62] + digits; number = Math.floor(number / 62); }
  const candidate = `c${digits}`;
  const greatest = elements.reduce((max, element) => typeof element.index === 'string' && element.index > max ? element.index : max, 'a0');
  return candidate > greatest ? candidate : `${greatest}V`;
}
function common(type, elementId, elements) {
  return {
    id: elementId, type, x: 0, y: 0, width: 180, height: 100, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, index: nextIndex(elements), roundness: type === 'rectangle' ? { type: 3 } : null,
    seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false,
    boundElements: null, updated: Date.now(), link: null, locked: false,
  };
}
function textMetrics(text, fontSize, maxWidth = Infinity) {
  const rows = [];
  const widths = [];
  for (const line of text.split('\n')) {
    let row = '', width = 0;
    for (const char of line) {
      const advance = /[^\u0000-\u00ff]/u.test(char) ? fontSize : fontSize * 0.58;
      if (row && width + advance > maxWidth) { rows.push(row); widths.push(width); row = ''; width = 0; }
      row += char; width += advance;
    }
    rows.push(row); widths.push(width);
  }
  return { text: rows.join('\n'), width: widths.reduce((max, width) => Math.max(max, width), 1), height: Math.max(1, rows.length) * fontSize * 1.25 };
}
function textData(text, fontSize = 20, containerId = null) {
  return { fontSize, fontFamily: 1, text, originalText: text, textAlign: containerId ? 'center' : 'left', verticalAlign: containerId ? 'middle' : 'top', containerId, autoResize: true, lineHeight: 1.25 };
}
function layoutLabel(container, label) {
  const maxWidth = container.type === 'arrow' ? Math.max(100, container.width - 16) : Math.max(10, container.width - 20);
  label.originalText ??= label.text ?? '';
  label.fontSize ??= 20;
  const metrics = textMetrics(label.originalText, label.fontSize, maxWidth);
  label.text = metrics.text;
  label.width = Math.min(metrics.width, maxWidth);
  label.height = metrics.height;
  if (container.type === 'arrow') {
    const first = container.points[0];
    const last = container.points.at(-1);
    label.x = container.x + (first[0] + last[0]) / 2 - label.width / 2;
    label.y = container.y + (first[1] + last[1]) / 2 - label.height / 2;
  } else {
    label.x = container.x + (container.width - label.width) / 2;
    label.y = container.y + (container.height - label.height) / 2;
  }
  label.angle = container.type === 'arrow' ? 0 : container.angle;
}
function bindReference(target, bound) {
  target.boundElements ??= [];
  if (!target.boundElements.some((entry) => entry.id === bound.id)) target.boundElements.push({ id: bound.id, type: bound.type });
}
function rebuildReferences(elements) {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const expected = new Map(elements.map((element) => [element.id, []]));
  for (const element of elements) {
    if (element.isDeleted) continue;
    if (element.type === 'text' && element.containerId) expected.get(element.containerId)?.push({ id: element.id, type: 'text' });
    if (element.type === 'arrow') {
      for (const binding of [element.startBinding, element.endBinding]) {
        if (!binding) continue;
        const refs = expected.get(binding.elementId);
        if (refs && !refs.some((entry) => entry.id === element.id)) refs.push({ id: element.id, type: 'arrow' });
      }
    }
  }
  for (const [elementId, refs] of expected) {
    const element = byId.get(elementId);
    const next = refs.length ? refs : null;
    const actual = element.boundElements ?? [];
    if (actual.length !== refs.length || actual.some((entry) => !refs.some((ref) => ref.id === entry.id && ref.type === entry.type))) {
      element.boundElements = next;
      bump(element);
    }
  }
}
function center(element) { return [element.x + element.width / 2, element.y + element.height / 2]; }
function edgePoint(element, toward, gap = 8) {
  const [cx, cy] = center(element);
  let dx = toward[0] - cx;
  let dy = toward[1] - cy;
  if (dx === 0 && dy === 0) dx = 1;
  const angle = element.angle ?? 0;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const localX = cos * dx + sin * dy, localY = -sin * dx + cos * dy;
  const rx = Math.max(element.width / 2, 1), ry = Math.max(element.height / 2, 1);
  const scale = element.type === 'ellipse'
    ? 1 / Math.sqrt((localX / rx) ** 2 + (localY / ry) ** 2)
    : element.type === 'diamond'
      ? 1 / (Math.abs(localX / rx) + Math.abs(localY / ry))
      : Math.min(localX === 0 ? Infinity : rx / Math.abs(localX), localY === 0 ? Infinity : ry / Math.abs(localY));
  const distance = Math.hypot(dx, dy);
  return [cx + dx * scale + dx / distance * gap, cy + dy * scale + dy / distance * gap];
}
function updateArrow(arrow, byId) {
  const first = arrow.points[0], last = arrow.points.at(-1);
  let start = [arrow.x + first[0], arrow.y + first[1]];
  let end = [arrow.x + last[0], arrow.y + last[1]];
  const startNode = byId.get(arrow.startBinding?.elementId);
  const endNode = byId.get(arrow.endBinding?.elementId);
  if (startNode) start = edgePoint(startNode, endNode ? center(endNode) : end, arrow.startBinding.gap ?? 8);
  if (endNode) end = edgePoint(endNode, startNode ? center(startNode) : start, arrow.endBinding.gap ?? 8);
  if (!startNode && !endNode) return;
  const middle = arrow.points.slice(1, -1).map(([x, y]) => [arrow.x + x - start[0], arrow.y + y - start[1]]);
  const nextPoints = [[0, 0], ...middle, [end[0] - start[0], end[1] - start[1]]];
  const xs = nextPoints.map((point) => point[0]), ys = nextPoints.map((point) => point[1]);
  if (arrow.x !== start[0] || arrow.y !== start[1] || JSON.stringify(arrow.points) !== JSON.stringify(nextPoints)) {
    arrow.x = start[0]; arrow.y = start[1]; arrow.points = nextPoints;
    arrow.width = Math.max(...xs) - Math.min(...xs); arrow.height = Math.max(...ys) - Math.min(...ys);
    bump(arrow);
  }
}
function setBinding(arrow, side, nodeId, byId) {
  if (nodeId === undefined) return;
  const node = byId.get(nodeId);
  if (!node || node.isDeleted || !BINDABLE.has(node.type) || node.containerId) invalid(`Cannot bind arrow to missing or invalid node: ${nodeId}`);
  arrow[`${side}Binding`] = { elementId: nodeId, focus: 0, gap: 8, fixedPoint: null };
}
function validateOperation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) invalid('Operation must be an object');
  for (const key of Object.keys(operation)) if (!OP_KEYS.has(key)) invalid(`Unknown operation property: ${key}`);
  if (!['add', 'update', 'delete'].includes(operation.op)) invalid('Invalid operation kind');
  id(operation.id);
  if (operation.type !== undefined && !OP_TYPES.has(operation.type)) invalid('Invalid operation type');
  for (const key of ['x', 'y', 'width', 'height', 'fontSize']) if (operation[key] !== undefined) finite(operation[key], key);
  for (const key of ['width', 'height']) if (operation[key] !== undefined && operation[key] < 0) invalid('Dimensions cannot be negative');
  if (operation.fontSize !== undefined && (operation.fontSize <= 0 || operation.fontSize > 1000)) invalid('fontSize must be between 0 and 1000');
  if (operation.text !== undefined && typeof operation.text !== 'string') invalid('text must be a string');
  for (const key of ['strokeColor', 'backgroundColor']) if (operation[key] !== undefined) color(operation[key], key);
  for (const key of ['startId', 'endId']) if (operation[key] !== undefined) id(operation[key], key);
  if (operation.points !== undefined) points(operation.points, 'points');
  if (operation.op === 'delete' && Object.keys(operation).some((key) => !['op', 'id'].includes(key))) invalid('Delete only accepts op and id');
}

/** Validate and capture a batch before it can wait in a store queue. */
export function validateOperations(operations) {
  const ops = jsonClone(operations);
  if (!Array.isArray(ops) || ops.length > 100) invalid('operations must be an array of at most 100 operations');
  ops.forEach(validateOperation);
  return ops;
}

/** Apply a whole batch on a detached scene; revisions are owned exclusively by BoardStore. */
export function applyOperations(board, operations) {
  if (!board || typeof board !== 'object') invalid('board must be an object');
  validateSessionId(board.sessionId);
  if (!Number.isSafeInteger(board.revision) || board.revision < 0) invalid('Invalid board revision');
  const scene = validateScene({ elements: board.elements, files: board.files ?? {}, selectedIds: board.selectedIds ?? [] });
  const ops = validateOperations(operations);
  const elements = scene.elements;
  const byId = new Map(elements.map((element) => [element.id, element]));
  const changedIds = new Set();
  function labelFor(container, operation) {
    if (!CONTAINERS.has(container.type)) {
      if (operation.text !== undefined) invalid('Only nodes and arrows may have bound text');
      return;
    }
    let label = elements.find((entry) => !entry.isDeleted && entry.type === 'text' && entry.containerId === container.id);
    if (!label && operation.text !== undefined) {
      const labelId = `${container.id}__label`;
      id(labelId, 'label id');
      if (byId.has(labelId)) invalid(`Label id is already reserved: ${labelId}`);
      label = { ...common('text', labelId, elements), ...textData(operation.text, operation.fontSize ?? 20, container.id), strokeWidth: 1, roundness: null };
      label.strokeColor = container.strokeColor;
      elements.push(label); byId.set(label.id, label); bindReference(container, label);
    }
    if (label) {
      if (operation.text !== undefined) label.originalText = operation.text;
      if (operation.fontSize !== undefined) label.fontSize = operation.fontSize;
      if (operation.strokeColor !== undefined) label.strokeColor = operation.strokeColor;
      layoutLabel(container, label);
      bump(label);
    }
  }
  function tombstone(element) {
    if (element.isDeleted) return;
    element.isDeleted = true;
    if (element.type === 'arrow') { element.startBinding = null; element.endBinding = null; }
    if (element.type === 'text') element.containerId = null;
    element.boundElements = null;
    bump(element);
    for (const linked of elements) {
      if (linked.isDeleted) continue;
      if (linked.frameId === element.id) { linked.frameId = null; bump(linked); }
      if (linked.containerId === element.id || (linked.type === 'arrow' && (linked.startBinding?.elementId === element.id || linked.endBinding?.elementId === element.id))) tombstone(linked);
    }
  }
  for (const operation of ops) {
    changedIds.add(operation.id);
    let element = byId.get(operation.id);
    if (operation.op === 'add') {
      if (element) invalid(`Element id is already reserved: ${operation.id}`);
      if (!OP_TYPES.has(operation.type)) invalid('Add requires a supported type');
      element = common(operation.type, operation.id, elements);
      if (element.type === 'text') {
        Object.assign(element, textData(operation.text ?? '', operation.fontSize ?? 20));
        Object.assign(element, textMetrics(element.text, element.fontSize));
        element.strokeWidth = 1;
      }
      if (element.type === 'arrow' || element.type === 'line') {
        element.width = 200; element.height = 0;
        element.points = [[0, 0], [200, 0]]; element.lastCommittedPoint = null;
        element.startBinding = null; element.endBinding = null;
        element.startArrowhead = null; element.endArrowhead = element.type === 'arrow' ? 'arrow' : null;
        if (element.type === 'arrow') element.elbowed = false;
      }
      elements.push(element); byId.set(element.id, element);
    } else {
      if (!element || element.isDeleted) invalid(`Cannot ${operation.op} missing or deleted element: ${operation.id}`);
      if (operation.type !== undefined && operation.type !== element.type) invalid('Element type is immutable');
      if (operation.op === 'delete') { tombstone(element); continue; }
    }
    if ((operation.startId !== undefined || operation.endId !== undefined) && element.type !== 'arrow') invalid('Only arrows accept startId/endId');
    if (operation.points !== undefined && !['arrow', 'line'].includes(element.type)) invalid('Only arrows and lines accept points');
    for (const key of ['x', 'y', 'width', 'height', 'strokeColor', 'backgroundColor']) if (operation[key] !== undefined) element[key] = operation[key];
    if (element.type === 'text') {
      element.originalText ??= element.text ?? '';
      element.fontSize ??= 20;
      if (operation.text !== undefined) element.originalText = operation.text;
      if (operation.fontSize !== undefined) element.fontSize = operation.fontSize;
      const metrics = textMetrics(element.originalText, element.fontSize);
      element.text = metrics.text;
      if (operation.width === undefined) element.width = metrics.width;
      if (operation.height === undefined) element.height = metrics.height;
    } else labelFor(element, operation);
    if (element.type === 'arrow' || element.type === 'line') {
      if (operation.points !== undefined) element.points = operation.points;
      else if (operation.width !== undefined || operation.height !== undefined) {
        const last = element.points.at(-1);
        element.points = [[0, 0], [operation.width ?? last[0], operation.height ?? last[1]]];
      }
      const xs = element.points.map((point) => point[0]), ys = element.points.map((point) => point[1]);
      element.width = Math.max(...xs) - Math.min(...xs); element.height = Math.max(...ys) - Math.min(...ys);
      if (element.type === 'arrow') {
        setBinding(element, 'start', operation.startId, byId);
        setBinding(element, 'end', operation.endId, byId);
      }
    }
    if (operation.op === 'update') bump(element);
  }
  for (const element of elements) {
    if (!element.isDeleted && element.type === 'arrow' && (changedIds.has(element.id) || changedIds.has(element.startBinding?.elementId) || changedIds.has(element.endBinding?.elementId))) {
      updateArrow(element, byId);
      changedIds.add(element.id);
    }
  }
  for (const element of elements) {
    if (!element.isDeleted && element.type === 'text' && element.containerId && (changedIds.has(element.id) || changedIds.has(element.containerId))) {
      const before = JSON.stringify([element.x, element.y, element.width, element.height, element.text]);
      layoutLabel(byId.get(element.containerId), element);
      if (before !== JSON.stringify([element.x, element.y, element.width, element.height, element.text])) bump(element);
    }
  }
  rebuildReferences(elements);
  scene.selectedIds = scene.selectedIds.filter((selectedId) => !byId.get(selectedId).isDeleted);
  return { sessionId: board.sessionId, revision: board.revision, ...validateScene(scene), updatedAt: new Date().toISOString() };
}
