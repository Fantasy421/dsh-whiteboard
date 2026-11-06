import { linearWorldPoints } from './linear.mjs';

// Local reading state only: these helpers never repair bindings or update a scene.
const NODE_TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'image', 'frame']);
const isEdge = element => element?.type === 'line' || element?.type === 'arrow';
const isNode = element => NODE_TYPES.has(element?.type);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const emptyNeighborhood = () => ({ focusId: null, nodeIds: [], edgeIds: [], labelIds: [], highlightIds: [] });

function sceneIndex(elements) {
  const scene = [], byId = new Map(), labelOwners = new Map();
  for (const element of Array.isArray(elements) ? elements : []) {
    if (!element || element.isDeleted || typeof element.id !== 'string' || !element.id || byId.has(element.id)) continue;
    scene.push(element);
    byId.set(element.id, element);
  }
  // containerId is authoritative, even when its target has been deleted. Do not
  // promote an orphaned bound label to a standalone reading node.
  for (const element of scene) {
    if (element.type === 'text' && element.containerId != null) labelOwners.set(element.id, element.containerId);
  }
  for (const owner of scene) {
    if (!isNode(owner) && !isEdge(owner)) continue;
    for (const binding of Array.isArray(owner.boundElements) ? owner.boundElements : []) {
      const label = byId.get(binding?.id);
      if (binding?.type === 'text' && label?.type === 'text' && !labelOwners.has(label.id)) labelOwners.set(label.id, owner.id);
    }
  }
  return { scene, byId, labelOwners };
}

function resolveNode(index, id) {
  const element = index.byId.get(id);
  if (!isNode(element)) return null;
  if (element.type !== 'text' || !index.labelOwners.has(id)) return element.id;
  const owner = index.byId.get(index.labelOwners.get(id));
  // Only explicit, non-text node containers count; never follow ownership chains.
  return isNode(owner) && owner.type !== 'text' ? owner.id : null;
}

/**
 * One-hop, undirected neighborhood of a live node (or its explicit bound label).
 * All returned ID arrays follow scene order, including the union highlightIds.
 * An incident edge remains highlighted if its other endpoint is absent/deleted.
 */
export function readingNeighborhood(elements, nodeId) {
  const index = sceneIndex(elements), focusId = resolveNode(index, nodeId);
  if (!focusId) return emptyNeighborhood();
  const nodes = new Set([focusId]), edges = new Set(), labels = new Set();
  for (const element of index.scene) {
    if (!isEdge(element)) continue;
    const start = resolveNode(index, element.startBinding?.elementId);
    const end = resolveNode(index, element.endBinding?.elementId);
    if (start !== focusId && end !== focusId) continue;
    edges.add(element.id);
    if (start) nodes.add(start);
    if (end) nodes.add(end);
  }
  for (const [labelId, ownerId] of index.labelOwners) {
    if (nodes.has(ownerId) || edges.has(ownerId)) labels.add(labelId);
  }
  const ordered = ids => index.scene.filter(element => ids.has(element.id)).map(element => element.id);
  return {
    focusId, nodeIds: ordered(nodes), edgeIds: ordered(edges), labelIds: ordered(labels),
    highlightIds: ordered(new Set([...nodes, ...edges, ...labels])),
  };
}

function nodeGeometry(element) {
  if (!element || element.isDeleted || !isNode(element)) return null;
  const { x, y, width, height } = element, angle = element.angle ?? 0;
  if (![x, y, width, height, angle].every(finite) || width === 0 || height === 0) return null;
  const left = Math.min(x, x + width), top = Math.min(y, y + height);
  const w = Math.abs(width), h = Math.abs(height), cx = left + w / 2, cy = top + h / 2;
  if (![left, top, w, h, cx, cy, left + w, top + h].every(finite)) return null;
  return { left, top, w, h, cx, cy, angle };
}

function contains(element, point, frameInterior = false) {
  const geometry = nodeGeometry(element);
  if (!geometry) return false;
  const { w, h, cx, cy, angle } = geometry;
  const cos = Math.cos(angle), sin = Math.sin(angle), dx = point.x - cx, dy = point.y - cy;
  const x = Math.abs(dx * cos + dy * sin), y = Math.abs(-dx * sin + dy * cos);
  if (![x, y].every(finite)) return false;
  if (element.type === 'ellipse') return (x / (w / 2)) ** 2 + (y / (h / 2)) ** 2 <= 1 + 1e-12;
  if (element.type === 'diamond') return x / (w / 2) + y / (h / 2) <= 1 + 1e-12;
  // A frame is a container, not a huge click target: only its five-scene-pixel
  // border band is hittable (on either side); its empty interior passes through.
  if (element.type === 'frame' && !frameInterior) return x <= w / 2 + 5 && y <= h / 2 + 5 && (x >= w / 2 - 5 || y >= h / 2 - 5);
  return x <= w / 2 + 1e-12 && y <= h / 2 + 1e-12;
}

function clippingFrame(element, index, frameRendering) {
  if (!element || element.isDeleted || frameRendering?.enabled === false || frameRendering?.clip === false) return null;
  const frame = index.byId.get(element.frameId);
  return frame?.type === 'frame' && frame !== element && nodeGeometry(frame) ? frame : null;
}

/**
 * SVG clip for explicit live frameId content, not frame/group ownership inference.
 * Native defaults enable clipping; missing/deleted/invalid frames do not clip.
 */
export function readingClip(element, elements, frameRendering) {
  const frame = clippingFrame(element, sceneIndex(elements), frameRendering);
  return frame ? readingOutline(frame) : null;
}

/** Topmost visible filled node footprint; edge labels are not reading nodes. */
export function hitReadingNode(elements, point, { frameRendering } = {}) {
  if (!point || !finite(point.x) || !finite(point.y)) return null;
  const index = sceneIndex(elements);
  for (let i = index.scene.length - 1; i >= 0; i--) {
    const element = index.scene[i];
    if (!isNode(element) || !contains(element, point)) continue;
    const frame = clippingFrame(element, index, frameRendering);
    if (frame && !contains(frame, point, true)) continue;
    const id = resolveNode(index, element.id);
    if (id) return id;
  }
  return null;
}

function edgeOutline(element) {
  if (!finite(element.x) || !finite(element.y) || (element.angle != null && !finite(element.angle))) return null;
  let points;
  try { points = linearWorldPoints(element); } catch { return null; }
  if (points.some(point => !point.every(finite))) return null;
  let d = `M ${points[0].join(' ')}`;
  if (element.roundness && !element.elbowed && points.length > 2) {
    // Native ideal RoughJS Catmull-Rom curve, tightness 0, repeated endpoint
    // controls. Affine rotation commutes with this cubic construction.
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 2)];
      const c1 = [a[0] + (b[0] - before[0]) / 6, a[1] + (b[1] - before[1]) / 6];
      const c2 = [b[0] + (a[0] - after[0]) / 6, b[1] + (a[1] - after[1]) / 6];
      if (![...c1, ...c2].every(finite)) return null;
      d += ` C ${c1.join(' ')} ${c2.join(' ')} ${b.join(' ')}`;
    }
  } else {
    for (const point of points.slice(1)) d += ` L ${point.join(' ')}`;
  }
  return { d };
}

/** Ideal SVG highlight stroke; node rotation is an optional SVG transform. */
export function readingOutline(element) {
  if (!element || element.isDeleted) return null;
  if (isEdge(element)) return edgeOutline(element);
  const geometry = nodeGeometry(element);
  if (!geometry) return null;
  const { left: x, top: y, w, h, cx, cy, angle } = geometry;
  let d;
  if (element.type === 'ellipse') {
    d = `M ${x} ${cy} A ${w / 2} ${h / 2} 0 1 0 ${x + w} ${cy} A ${w / 2} ${h / 2} 0 1 0 ${x} ${cy} Z`;
  } else if (element.type === 'diamond') {
    d = `M ${cx} ${y} L ${x + w} ${cy} L ${cx} ${y + h} L ${x} ${cy} Z`;
  } else {
    d = `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
  }
  const degrees = angle * (180 / Math.PI);
  if (!finite(degrees)) return null;
  return angle ? { d, transform: `rotate(${degrees} ${cx} ${cy})` } : { d };
}
