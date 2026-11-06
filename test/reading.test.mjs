import test from 'node:test';
import assert from 'node:assert/strict';
import { hitReadingNode, readingClip, readingNeighborhood, readingOutline } from '../src/reading.mjs';

const node = (id, extra = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 100, height: 80, angle: 0, version: 7, versionNonce: 13, updated: 123, ...extra });
const edge = (id, start, end, extra = {}) => ({
  ...node(id), type: 'arrow', points: [[0, 0], [100, 0]], roundness: null,
  startBinding: start == null ? null : { elementId: start, focus: 0, gap: 4 },
  endBinding: end == null ? null : { elementId: end, focus: 0, gap: 4 }, ...extra,
});
const label = (id, containerId, extra = {}) => node(id, { type: 'text', containerId, ...extra });
const empty = { focusId: null, nodeIds: [], edgeIds: [], labelIds: [], highlightIds: [] };
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-8, `${actual} ≈ ${expected}`);
const numbers = d => [...d.matchAll(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)].map(match => Number(match[0]));
const worldPoint = (element, x, y) => {
  const cx = element.x + element.width / 2, cy = element.y + element.height / 2;
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * Math.cos(element.angle) - dy * Math.sin(element.angle), y: cy + dx * Math.sin(element.angle) + dy * Math.cos(element.angle) };
};

test('one hop includes incoming/outgoing bindings, not transitive edges or geometric crossings', () => {
  const elements = freeze([
    node('c'), edge('bc', 'b', 'c'), node('a', { groupIds: ['group'], frameId: 'frame' }),
    edge('in', 'b', 'a', { type: 'line' }), node('b'), edge('out', 'a', 'd'), node('d'),
    edge('crossing', null, null), node('same-group', { groupIds: ['group'] }), node('frame', { type: 'frame' }),
  ]);
  assert.deepEqual(readingNeighborhood(elements, 'a'), {
    focusId: 'a', nodeIds: ['a', 'b', 'd'], edgeIds: ['in', 'out'], labelIds: [],
    highlightIds: ['a', 'in', 'b', 'out', 'd'],
  });
  assert.deepEqual(readingNeighborhood(elements, 'c').nodeIds, ['c', 'b']);
});

test('parallel, self, one-ended and dangling edges are stable and deduplicated', () => {
  const elements = freeze([
    node('a', { locked: true }), edge('self', 'a', 'a'), edge('parallel1', 'a', 'b'),
    edge('parallel2', 'b', 'a'), edge('one-ended', null, 'a'), edge('dangling', 'a', 'missing'),
    edge('deleted-target', 'a', 'gone'), edge('deleted-edge', 'a', 'other', { isDeleted: true }),
    edge('not-node-target', 'a', 'stroke'), node('b'), node('gone', { isDeleted: true }),
    node('other'), node('stroke', { type: 'freedraw' }),
  ]);
  assert.deepEqual(readingNeighborhood(elements, 'a'), {
    focusId: 'a', nodeIds: ['a', 'b'],
    edgeIds: ['self', 'parallel1', 'parallel2', 'one-ended', 'dangling', 'deleted-target', 'not-node-target'], labelIds: [],
    highlightIds: ['a', 'self', 'parallel1', 'parallel2', 'one-ended', 'dangling', 'deleted-target', 'not-node-target', 'b'],
  });
  assert.deepEqual(readingNeighborhood(elements, 'gone'), empty);
  assert.deepEqual(readingNeighborhood(elements, 'stroke'), empty);
});

test('explicit node/edge labels are highlighted in scene order and clicks resolve only node labels', () => {
  const elements = freeze([
    label('edge-label', 'ab'), label('b-label', 'b'), label('a-label', 'a'), node('b'),
    edge('ab', 'a', 'b'), node('a'), label('dead-label', 'a', { isDeleted: true }),
    label('orphan-label', 'deleted-owner'), edge('bc', 'b', 'c'), label('transitive-label', 'bc'), node('c'),
  ]);
  const expected = {
    focusId: 'a', nodeIds: ['b', 'a'], edgeIds: ['ab'], labelIds: ['edge-label', 'b-label', 'a-label'],
    highlightIds: ['edge-label', 'b-label', 'a-label', 'b', 'ab', 'a'],
  };
  assert.deepEqual(readingNeighborhood(elements, 'a-label'), expected);
  assert.deepEqual(readingNeighborhood(elements, 'a'), expected);
  for (const id of ['edge-label', 'orphan-label', 'dead-label']) assert.deepEqual(readingNeighborhood(elements, id), empty);
});

test('explicit boundElements text fallback works but stale or conflicting containerId wins', () => {
  const elements = freeze([
    node('a', { boundElements: [{ type: 'text', id: 'fallback' }, { type: 'text', id: 'conflict' }, { type: 'text', id: 'missing' }] }),
    label('fallback', null), label('conflict', 'ab'),
    edge('ab', 'a', null, { boundElements: [{ type: 'text', id: 'edge-fallback' }, { type: 'text', id: 'orphan' }] }),
    label('edge-fallback', undefined), label('orphan', 'deleted-owner'),
  ]);
  assert.equal(readingNeighborhood(elements, 'fallback').focusId, 'a');
  assert.deepEqual(readingNeighborhood(elements, 'a').labelIds, ['fallback', 'conflict', 'edge-fallback']);
  for (const id of ['conflict', 'edge-fallback', 'orphan']) assert.deepEqual(readingNeighborhood(elements, id), empty);
});

test('all supported live node types and locked nodes participate without mutation', () => {
  const types = ['rectangle', 'diamond', 'ellipse', 'text', 'image', 'frame'];
  const elements = freeze(types.flatMap((type, i) => [node(type, { type, locked: true }), ...(i ? [edge(`e${i}`, 'rectangle', type)] : [])]));
  const snapshot = structuredClone(elements);
  assert.deepEqual(readingNeighborhood(elements, 'rectangle').nodeIds, types);
  for (const element of elements) {
    readingOutline(element);
    hitReadingNode(elements, { x: 1, y: 1 });
  }
  assert.deepEqual(elements, snapshot);
  const result = readingNeighborhood(elements, 'rectangle');
  result.nodeIds.push('local-only');
  assert.deepEqual(readingNeighborhood(elements, 'rectangle').nodeIds, types);
});

test('missing, deleted and unsupported focus produces empty fresh results', () => {
  for (const elements of [null, undefined, {}, [null, {}, false, node('deleted', { isDeleted: true }), node('unsupported', { type: 'embeddable' })]]) {
    for (const id of [null, undefined, 'missing', 'deleted', 'unsupported', 4]) assert.deepEqual(readingNeighborhood(elements, id), empty);
    assert.equal(hitReadingNode(elements, { x: 0, y: 0 }), null);
  }
});

test('hit testing uses reverse scene order, transparent interiors and locked nodes', () => {
  const elements = freeze([node('back'), node('front', { backgroundColor: 'transparent', locked: true }), node('deleted', { isDeleted: true }), edge('edge', null, null)]);
  assert.equal(hitReadingNode(elements, { x: 50, y: 40 }), 'front');
  assert.equal(hitReadingNode(elements, { x: 0, y: 0 }), 'front');
  assert.equal(hitReadingNode(elements, { x: 101, y: 40 }), null);
});

test('node labels hit their explicit container; edge/orphan labels cannot steal node clicks', () => {
  const elements = freeze([
    node('back'), node('container', { x: 200 }), edge('edge', 'back', 'container'),
    label('node-label', 'container', { x: 20, y: 20, width: 20, height: 20 }),
    label('edge-label', 'edge', { x: 60, y: 20, width: 20, height: 20 }),
    label('orphan-label', 'deleted', { x: 0, y: 0, width: 10, height: 10 }),
  ]);
  assert.equal(hitReadingNode(elements, { x: 30, y: 30 }), 'container');
  assert.equal(hitReadingNode(elements, { x: 70, y: 30 }), 'back');
  assert.equal(hitReadingNode(elements, { x: 5, y: 5 }), 'back');
  assert.equal(hitReadingNode([elements[4]], { x: 70, y: 30 }), null);
});

test('inverse rotated rectangles, images and standalone text use their full footprint', () => {
  for (const type of ['rectangle', 'image', 'text']) {
    const element = freeze(node(type, { type, x: 10, y: 20, width: 120, height: 20, angle: Math.PI / 2 }));
    assert.equal(hitReadingNode([element], { x: 70, y: 80 }), type);
    assert.equal(hitReadingNode([element], { x: 15, y: 30 }), null);
    assert.equal(hitReadingNode([element], worldPoint(element, 10, 20)), type);
  }
});

test('rotated ellipses and diamonds do not hit their bounding-box corners', () => {
  for (const type of ['ellipse', 'diamond']) {
    const element = freeze(node(type, { type, x: -30, y: 15, width: 120, height: 60, angle: Math.PI / 3 }));
    for (const [x, y] of [[30, 45], [89, 45], [30, 15]]) assert.equal(hitReadingNode([element], worldPoint(element, x, y)), type);
    for (const [x, y] of [[89, 16], [-29, 74], [91, 45]]) assert.equal(hitReadingNode([element], worldPoint(element, x, y)), null);
  }
});

test('frame hit targets only a five-scene-pixel rotated border, never its contents', () => {
  const frame = freeze(node('frame', { type: 'frame', x: 0, y: 0, width: 200, height: 160, angle: Math.PI / 4 }));
  for (const [x, y] of [[0, 80], [-4, 80], [4, 80], [100, 164]]) assert.equal(hitReadingNode([frame], worldPoint(frame, x, y)), 'frame');
  for (const [x, y] of [[100, 80], [6, 80], [-6, 80], [100, 166]]) assert.equal(hitReadingNode([frame], worldPoint(frame, x, y)), null);
  assert.equal(hitReadingNode([node('inside', { x: 90, y: 70, width: 20, height: 20 }), frame], { x: 100, y: 80 }), 'inside');
});

test('rectangle-like, diamond and ellipse SVG paths describe world geometry and rotation', () => {
  for (const type of ['rectangle', 'image', 'text', 'frame']) {
    const element = freeze(node(type, { type, x: 10, y: 20, width: 80, height: 40, angle: Math.PI / 2 }));
    assert.deepEqual(readingOutline(element), { d: 'M 10 20 L 90 20 L 90 60 L 10 60 Z', transform: 'rotate(90 50 40)' });
  }
  assert.deepEqual(readingOutline(node('d', { type: 'diamond', x: 10, y: 20, width: 80, height: 40 })), { d: 'M 50 20 L 90 40 L 50 60 L 10 40 Z' });
  assert.deepEqual(readingOutline(node('e', { type: 'ellipse', x: 10, y: 20, width: 80, height: 40 })), { d: 'M 10 40 A 40 20 0 1 0 90 40 A 40 20 0 1 0 10 40 Z' });
});

test('straight and sharp multi-point paths preserve world offsets and native rotation', () => {
  assert.deepEqual(readingOutline(edge('line', null, null, { type: 'line', x: 10, y: -20, points: [[-5, 2], [30, 2], [30, 70]] })), { d: 'M 5 -18 L 40 -18 L 40 50' });
  const rotated = readingOutline(edge('rotated', null, null, { x: 10, y: 20, angle: Math.PI / 2, points: [[0, 0], [100, 0]] }));
  numbers(rotated.d).forEach((value, index) => near(value, [60, -30, 60, 70][index]));
  assert.equal(rotated.transform, undefined);
});

test('round multi-control edges use ideal Catmull-Rom cubics with repeated endpoints', () => {
  const element = freeze(edge('curve', null, null, { x: 10, y: -20, points: [[0, 0], [60, 60], [120, 0]], roundness: { type: 2 } }));
  assert.deepEqual(readingOutline(element), { d: 'M 10 -20 C 20 -10 50 40 70 40 C 90 40 120 -10 130 -20' });
  assert.equal((readingOutline(element).d.match(/C/g) ?? []).length, 2);
  const rotated = readingOutline({ ...element, angle: Math.PI / 2 });
  const expected = [100, -50, 90, -40, 40, -10, 40, 10, 40, 30, 90, 60, 100, 70];
  numbers(rotated.d).forEach((value, index) => near(value, expected[index]));
  assert.equal(rotated.transform, undefined);
});

test('two-control round paths and elbowed paths stay straight/sharp, without arrowheads', () => {
  assert.equal(readingOutline(edge('two', null, null, { roundness: { type: 2 } })).d, 'M 0 0 L 100 0');
  assert.equal(readingOutline(edge('elbow', null, null, { roundness: { type: 2 }, elbowed: true, points: [[0, 0], [30, 40], [90, 40]] })).d, 'M 0 0 L 30 40 L 90 40');
});

test('negative node dimensions normalize footprint and outline without scene edits', () => {
  const element = freeze(node('negative', { x: 100, y: 80, width: -100, height: -80 }));
  assert.equal(hitReadingNode([element], { x: 50, y: 40 }), 'negative');
  assert.deepEqual(readingOutline(element), { d: 'M 0 0 L 100 0 L 100 80 L 0 80 Z' });
});

test('malformed, unsupported, nonfinite and degenerate geometry is harmless', () => {
  const invalid = [null, {}, false, node('deleted', { isDeleted: true }), node('free', { type: 'freedraw' }),
    node('nan', { x: NaN }), node('infinity', { width: Infinity }), node('bad-angle', { angle: '1' }),
    node('zero', { height: 0 }), node('missing', { x: undefined }), node('overflow', { x: Number.MAX_VALUE, width: Number.MAX_VALUE }),
    edge('missing-points', null, null, { points: undefined }), edge('short', null, null, { points: [[0, 0]] }),
    edge('bad-point', null, null, { points: [[0, 0], [NaN, 2]] }), edge('bad-origin', null, null, { x: Infinity }),
    edge('bad-angle', null, null, { angle: Infinity }), edge('bad-points', null, null, { points: [[0, 0], [1, 2, 3]] }),
    edge('overflow', null, null, { x: Number.MAX_VALUE, points: [[0, 0], [Number.MAX_VALUE, 0]] }),
  ];
  for (const value of freeze(invalid)) assert.equal(readingOutline(value), null);
  assert.equal(hitReadingNode(invalid, { x: 20, y: 20 }), null);
  for (const point of [null, {}, { x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: '1', y: 0 }]) assert.equal(hitReadingNode([node('a')], point), null);
});

test('default frame clipping rejects invisible child footprint, without clipping by geometry alone', () => {
  const frame = node('frame', { type: 'frame', width: 100, height: 100 });
  const child = node('child', { x: 60, y: 20, width: 80, height: 60, frameId: 'frame' });
  const elements = freeze([node('back', { x: 110, y: 20, width: 40, height: 60 }), frame, child]);
  const snapshot = structuredClone(elements);
  assert.equal(hitReadingNode(elements, { x: 80, y: 50 }), 'child');
  assert.equal(hitReadingNode(elements, { x: 100, y: 50 }), 'child');
  assert.equal(hitReadingNode(elements, { x: 120, y: 50 }), 'back');
  assert.equal(hitReadingNode([frame, child], { x: 120, y: 50 }), null);
  assert.deepEqual(readingClip(child, elements), { d: 'M 0 0 L 100 0 L 100 100 L 0 100 Z' });
  assert.deepEqual(elements, snapshot);
  assert.deepEqual(readingNeighborhood(elements, 'child').nodeIds, ['child']);
  assert.equal(hitReadingNode([frame, { ...child, frameId: null }], { x: 120, y: 50 }), 'child');
});

test('rotated frame containment uses its full clip rectangle, not border band or unrotated bounds', () => {
  const frame = node('frame', { type: 'frame', x: 0, y: 0, width: 120, height: 40, angle: Math.PI / 2 });
  const child = node('child', { x: -50, y: -50, width: 220, height: 140, frameId: 'frame' });
  const elements = freeze([frame, child]);
  assert.equal(hitReadingNode(elements, { x: 60, y: 20 }), 'child');
  assert.equal(hitReadingNode(elements, { x: 60, y: 70 }), 'child');
  assert.equal(hitReadingNode(elements, { x: 10, y: 20 }), null);
  assert.deepEqual(readingClip(child, elements), { d: 'M 0 0 L 120 0 L 120 40 L 0 40 Z', transform: 'rotate(90 60 20)' });
});

test('frame enabled:false or clip:false disables both hit and SVG clipping; unspecified flags default on', () => {
  const frame = node('frame', { type: 'frame', width: 100, height: 100 });
  const child = node('child', { x: 120, y: 20, width: 20, height: 20, frameId: 'frame' });
  const elements = freeze([frame, child]);
  for (const frameRendering of [undefined, null, {}, { enabled: true }, { clip: true }, { enabled: true, clip: true, outline: false }]) {
    assert.equal(hitReadingNode(elements, { x: 130, y: 30 }, { frameRendering }), null);
    assert.deepEqual(readingClip(child, elements, frameRendering), readingOutline(frame));
  }
  for (const frameRendering of [{ enabled: false }, { clip: false }, { enabled: false, clip: true }, { enabled: true, clip: false }]) {
    assert.equal(hitReadingNode(elements, { x: 130, y: 30 }, { frameRendering }), 'child');
    assert.equal(readingClip(child, elements, frameRendering), null);
  }
});

test('missing, deleted, non-frame and malformed frame targets do not clip children', () => {
  const child = freeze(node('child', { x: 120, y: 20, width: 20, height: 20, frameId: 'frame' }));
  for (const frame of [null, node('other', { type: 'frame' }), node('frame', { type: 'frame', isDeleted: true }), node('frame'), node('frame', { type: 'frame', x: NaN })]) {
    const elements = freeze([frame, child]);
    assert.equal(readingClip(child, elements), null);
    assert.equal(hitReadingNode(elements, { x: 130, y: 30 }), 'child');
  }
  for (const element of [null, {}, node('unframed'), node('deleted', { frameId: 'frame', isDeleted: true })]) {
    assert.equal(readingClip(element, [node('frame', { type: 'frame' })]), null);
  }
  assert.equal(readingClip(child, null), null);
});

test('clip helper applies equally to explicit frameId nodes, edges and labels, not graph ownership', () => {
  const frame = node('frame', { type: 'frame', width: 100, height: 100 });
  const elements = freeze([
    frame, node('child', { frameId: 'frame' }), edge('edge', 'child', 'outside', { frameId: 'frame' }),
    label('label', 'child', { frameId: 'frame' }), label('unframed-label', 'child'), node('outside', { x: 200 }),
  ]);
  for (const element of elements.slice(1, 4)) assert.deepEqual(readingClip(element, elements), readingOutline(frame));
  assert.equal(readingClip(elements[4], elements), null);
  assert.deepEqual(readingNeighborhood(elements, 'child').nodeIds, ['child', 'outside']);
  assert.deepEqual(readingNeighborhood(elements, 'frame').nodeIds, ['frame']);
});
