import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, emptyBoard, MAX_SCENE_BYTES, validateOperations, validateScene } from '../src/model.mjs';
import { LINE_STYLES, linearPathMidpoint, linearWorldPoints, styleLinearElement } from '../src/linear.mjs';

const shape = (id, extra = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 180, height: 100, ...extra });
const scene = (elements = [], files = {}, selectedIds = []) => ({ elements, files, selectedIds });
const find = (board, id) => board.elements.find((element) => element.id === id);
const diagram = () => applyOperations(emptyBoard('test'), [
  { op: 'add', id: 'a', type: 'rectangle', x: 10, y: 20, text: 'First' },
  { op: 'add', id: 'b', type: 'ellipse', x: 400, y: 20, text: '第二步' },
  { op: 'add', id: 'edge', type: 'arrow', startId: 'a', endId: 'b', text: 'Flow' },
]);
const rejected = (fn) => assert.throws(fn, { code: 'validation' });

// Small valid PNG header; file validation checks safe type/signature, not image decoding.
const png = { id: 'pixel', mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=', created: 1 };

test('empty boards are isolated and session ids are validated', () => {
  const first = emptyBoard('one');
  const second = emptyBoard('two');
  assert.equal(first.revision, 0);
  assert.ok(Number.isFinite(Date.parse(first.updatedAt)));
  first.elements.push(shape('a'));
  assert.deepEqual(second.elements, []);
  for (const value of ['', ' ', null, 3, 'x'.repeat(257)]) rejected(() => emptyBoard(value));
});

test('AI nodes and arrows are complete native elements with hand-drawn bound labels', () => {
  const board = diagram();
  assert.equal(board.revision, 0);
  assert.equal(board.elements.length, 6);
  const node = find(board, 'a'), label = find(board, 'a__label'), arrow = find(board, 'edge');
  for (const element of board.elements) {
    for (const key of ['version', 'seed', 'versionNonce', 'isDeleted', 'index', 'groupIds', 'frameId', 'updated', 'roundness', 'locked']) assert.ok(Object.hasOwn(element, key), key);
    assert.equal(element.isDeleted, false);
  }
  assert.equal(label.type, 'text');
  assert.equal(label.fontFamily, 1);
  assert.equal(label.containerId, node.id);
  assert.equal(label.originalText, 'First');
  assert.ok(label.width > 0 && label.height > 0);
  assert.ok(label.x >= node.x && label.y >= node.y);
  assert.ok(node.boundElements.some((entry) => entry.id === label.id && entry.type === 'text'));
  assert.ok(node.boundElements.some((entry) => entry.id === arrow.id && entry.type === 'arrow'));
  assert.equal(arrow.startBinding.elementId, 'a');
  assert.equal(arrow.endBinding.elementId, 'b');
  assert.equal(arrow.endArrowhead, 'arrow');
  assert.deepEqual(validateScene(board).elements, board.elements);
});

test('updates move bound arrows and labels, set color/text/size, and never mutate input', () => {
  const before = diagram();
  const snapshot = structuredClone(before);
  const moved = applyOperations(before, [{ op: 'update', id: 'a', x: 60, y: 200, width: 240, height: 140, text: 'Revised', fontSize: 28, strokeColor: '#f00', backgroundColor: '#eee' }]);
  assert.deepEqual(before, snapshot);
  assert.notEqual(find(moved, 'edge').y, find(before, 'edge').y);
  const node = find(moved, 'a'), label = find(moved, 'a__label');
  assert.equal(node.x, 60);
  assert.equal(node.width, 240);
  assert.equal(label.originalText, 'Revised');
  assert.equal(label.fontSize, 28);
  assert.equal(label.strokeColor, '#f00');
  assert.equal(label.x, node.x + (node.width - label.width) / 2);
  assert.equal(moved.revision, before.revision);
  assert.ok(node.version > find(before, 'a').version);
});

test('vertical arrow boundary geometry is outside both nodes', () => {
  const board = applyOperations(emptyBoard('s'), [
    { op: 'add', id: 'top', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
    { op: 'add', id: 'bottom', type: 'rectangle', x: 0, y: 300, width: 100, height: 100 },
    { op: 'add', id: 'arrow', type: 'arrow', startId: 'top', endId: 'bottom' },
  ]);
  const arrow = find(board, 'arrow');
  assert.equal(arrow.x, 50);
  assert.equal(arrow.y, 108);
  assert.equal(arrow.points.at(-1)[1], 184);
});

test('deletion preserves tombstones and cascades labels and connected arrows without dangling bindings', () => {
  const before = diagram();
  before.selectedIds = ['a', 'b', 'edge'];
  const after = applyOperations(before, [{ op: 'delete', id: 'a' }]);
  assert.equal(after.elements.length, before.elements.length);
  for (const id of ['a', 'a__label', 'edge', 'edge__label']) assert.equal(find(after, id).isDeleted, true, id);
  assert.equal(find(after, 'edge').startBinding, null);
  assert.equal(find(after, 'edge').endBinding, null);
  assert.deepEqual(find(after, 'b').boundElements, [{ id: 'b__label', type: 'text' }]);
  assert.deepEqual(after.selectedIds, ['b']);
  assert.doesNotThrow(() => validateScene(after));
  rejected(() => applyOperations(after, [{ op: 'add', id: 'a', type: 'rectangle' }]));
  rejected(() => applyOperations(after, [{ op: 'update', id: 'a', text: 'revive' }]));
});

test('deleting an arrow only detaches endpoint references', () => {
  const board = applyOperations(diagram(), [{ op: 'delete', id: 'edge' }]);
  assert.equal(find(board, 'a').isDeleted, false);
  assert.deepEqual(find(board, 'a').boundElements, [{ id: 'a__label', type: 'text' }]);
  assert.equal(find(board, 'edge__label').isDeleted, true);
});

test('whole batch failures are atomic, duplicate and generated ids never get reused', () => {
  const before = diagram(), snapshot = structuredClone(before);
  rejected(() => applyOperations(before, [{ op: 'update', id: 'a', x: 100 }, { op: 'update', id: 'absent', x: 4 }]));
  assert.deepEqual(before, snapshot);
  rejected(() => applyOperations(before, [{ op: 'add', id: 'a', type: 'ellipse' }]));
  rejected(() => applyOperations(before, [{ op: 'add', id: 'new', type: 'rectangle' }, { op: 'add', id: 'new', type: 'rectangle' }]));
  rejected(() => applyOperations(before, [{ op: 'update', id: 'a', type: 'ellipse' }]));
  const collision = applyOperations(emptyBoard('s'), [{ op: 'add', id: 'reserved__label', type: 'text', text: 'existing' }]);
  rejected(() => applyOperations(collision, [{ op: 'add', id: 'reserved', type: 'rectangle', text: 'label' }]));
});

test('operation schemas reject oversized, malformed, unsafe or dangling batches', () => {
  for (const ops of [null, {}, Array.from({ length: 101 }, (_, i) => ({ op: 'add', id: `n${i}`, type: 'rectangle' })),
    [{ op: 'add', id: 'x', type: 'image' }], [{ op: 'add', id: 'x', type: 'rectangle', x: NaN }],
    [{ op: 'add', id: 'x', type: 'arrow', startId: 'missing' }], [{ op: 'add', id: 'x', type: 'line', startId: 'missing' }],
    [{ op: 'add', id: 'x', type: 'rectangle', width: -1 }], [{ op: 'add', id: 'x', type: 'text', fontSize: 0 }],
    [{ op: 'add', id: 'x', type: 'rectangle', strokeColor: 'url(https://evil.test)' }],
    [{ op: 'add', id: 'x', type: 'rectangle', points: [[0, 0], [1, 1]] }],
    [{ op: 'add', id: 'x', type: 'rectangle', sneaky: true }], [{ op: 'delete', id: 'x', x: 1 }]]) {
    rejected(() => applyOperations(emptyBoard('s'), ops));
  }
});

test('line, arrow, text, diamond, ellipse operations produce valid native geometry', () => {
  const board = applyOperations(emptyBoard('s'), [
    { op: 'add', id: 'd', type: 'diamond', text: 'Choice?' },
    { op: 'add', id: 't', type: 'text', text: 'Standalone\ntext', x: 10, y: 20 },
    { op: 'add', id: 'l', type: 'line', points: [[0, 0], [-30, 40], [100, 60]] },
    { op: 'add', id: 'a', type: 'arrow', width: 100, height: 200 },
  ]);
  assert.equal(find(board, 'l').width, 130);
  assert.equal(find(board, 'l').height, 60);
  assert.equal(find(board, 't').height, 50);
  assert.equal(find(board, 't').containerId, null);
  assert.equal(find(board, 'a').points.at(-1)[1], 200);
  assert.doesNotThrow(() => validateScene(board));
});

test('scene validation clones data and keeps selection and supported native files', () => {
  const input = scene([shape('box'), shape('image', { type: 'image', fileId: 'pixel', scale: [1, 1] }), shape('pen', { type: 'freedraw', points: [[0, 0]], pressures: [0.4] })], { pixel: png }, ['box']);
  const output = validateScene(input);
  assert.deepEqual(output, input);
  output.elements[0].x = 99;
  output.files.pixel.dataURL = 'changed';
  output.selectedIds.push('image');
  assert.equal(input.elements[0].x, 0);
  assert.equal(input.files.pixel.dataURL, png.dataURL);
  assert.deepEqual(input.selectedIds, ['box']);
});

test('native frames are safe while embeds and dangling frame references are rejected', () => {
  const input = scene([shape('frame', { type: 'frame', name: 'Section' }), shape('box', { frameId: 'frame' })]);
  assert.doesNotThrow(() => validateScene(input));
  for (const type of ['embeddable', 'iframe', 'magicframe', 'javascript']) rejected(() => validateScene(scene([shape('x', { type })])));
  rejected(() => validateScene(scene([shape('box', { frameId: 'missing' })])));
});

test('native arrows may bind frames, but frames cannot be AI-created or contain bound text', () => {
  const input = scene([
    shape('frame', { type: 'frame', name: 'Section', boundElements: [{ id: 'arrow', type: 'arrow' }] }),
    shape('node', { x: 400, boundElements: [{ id: 'arrow', type: 'arrow' }] }),
    shape('arrow', { type: 'arrow', points: [[0, 0], [200, 0]], startBinding: { elementId: 'frame', focus: 0, gap: 8 }, endBinding: { elementId: 'node', focus: 0, gap: 8 } }),
  ]);
  assert.deepEqual(validateScene(input), input);
  const board = { ...emptyBoard('s'), ...input };
  const moved = applyOperations(board, [{ op: 'update', id: 'frame', y: 100 }]);
  assert.equal(find(moved, 'arrow').startBinding.elementId, 'frame');
  assert.notEqual(find(moved, 'arrow').y, find(board, 'arrow').y);
  const deleted = applyOperations(moved, [{ op: 'delete', id: 'frame' }]);
  assert.equal(find(deleted, 'arrow').isDeleted, true);
  assert.equal(find(deleted, 'arrow').startBinding, null);
  rejected(() => applyOperations(emptyBoard('s'), [{ op: 'add', id: 'frame', type: 'frame' }]));
  rejected(() => validateScene(scene([shape('frame', { type: 'frame' }), shape('label', { type: 'text', text: 'No frame bound text', containerId: 'frame' })])));
});

test('scene rejects missing/duplicate ids, malformed native data and dangling selection/bindings', () => {
  for (const input of [scene([shape('')]), scene([shape('x'), shape('x')]), scene([shape('x', { id: undefined })]),
    scene([shape('x', { x: '0' })]), scene([shape('x', { x: NaN })]), scene([shape('x', { width: -1 })]),
    scene([shape('x', { opacity: 101 })]), scene([shape('x', { isDeleted: 'false' })]),
    scene([shape('x', { fillStyle: {} })]), scene([shape('x', { link: 'file:///private' })]),
    scene([shape('x', { type: 'text', text: 1 })]), scene([shape('x', { type: 'arrow', points: [[0, 0]] })]),
    scene([shape('x', { type: 'text', text: 'hi', containerId: 'missing' })]),
    scene([shape('x', { boundElements: [{ id: 'missing', type: 'text' }] })]),
    scene([shape('x')], {}, ['missing']), scene([shape('x')], {}, ['x', 'x']),
    scene([shape('x', { isDeleted: true })], {}, ['x'])]) rejected(() => validateScene(input));
});

test('unsafe object graphs, scripts and prototype pollution are rejected without effects', () => {
  const cycle = scene(); cycle.loop = cycle;
  const accessor = scene(); Object.defineProperty(accessor, 'trap', { enumerable: true, get() { throw new Error('Getter must not run'); } });
  const inherited = Object.assign(Object.create({ evil: true }), scene());
  const sparse = scene(new Array(2));
  const polluted = JSON.parse('{"elements":[],"files":{},"selectedIds":[],"__proto__":{"polluted":true}}');
  for (const input of [cycle, accessor, inherited, sparse, polluted, { ...scene(), callback() {} }, { ...scene(), bad: Infinity }, { ...scene(), bad: 1n }, { ...scene(), constructor: {} },
    scene([shape('x', { link: 'data:text/html,<script>alert(1)</script>' })]), scene([shape('x', { link: 'javascript:alert(1)' })])]) rejected(() => validateScene(input));
  assert.doesNotThrow(() => validateScene(scene([shape('text', { type: 'text', text: '<script> and javascript: are plain diagram text' })])));
  assert.equal({}.polluted, undefined);
});

test('only embedded, correctly typed PNG/JPEG/WebP files are accepted', () => {
  for (const file of [{ ...png, dataURL: 'https://evil.test/a.png' }, { ...png, mimeType: 'image/svg+xml', dataURL: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { ...png, dataURL: 'data:image/png;base64,PHNjcmlwdD4=' }, { ...png, dataURL: 'data:image/jpeg;base64,/9j/' },
    { ...png, dataURL: 'data:image/png;base64,iVBORw0KGgo' }, { ...png, id: 'other' }]) rejected(() => validateScene(scene([], { pixel: file })));
  for (const file of [{ ...png }, { id: 'pixel', mimeType: 'image/jpeg', dataURL: 'data:image/jpeg;base64,/9j/' }, { id: 'pixel', mimeType: 'image/webp', dataURL: 'data:image/webp;base64,UklGRgAAAABXRUJQ' }]) assert.doesNotThrow(() => validateScene(scene([], { pixel: file })));
  rejected(() => validateScene(scene([shape('image', { type: 'image', fileId: 'missing' })])));
});

test('empty operations preserve native geometry, versions and binding order', () => {
  const before = diagram();
  find(before, 'a').boundElements.reverse();
  const arrow = find(before, 'edge');
  arrow.points = [[0, 0], [100, -90], [arrow.width, arrow.height]];
  const after = applyOperations(before, []);
  assert.deepEqual(after.elements, before.elements);
  assert.notEqual(after.elements, before.elements);
});

test('minimal validated native text can be moved without requiring optional font metrics', () => {
  const board = { ...emptyBoard('s'), ...scene([shape('t', { type: 'text', text: 'Native text' })]) };
  const after = applyOperations(board, [{ op: 'update', id: 't', x: 50 }]);
  assert.equal(find(after, 't').x, 50);
  assert.equal(find(after, 't').text, 'Native text');
  assert.equal(find(after, 't').fontSize, 20);
});

test('AI add and update styles persist as editable native lines and arrows', () => {
  for (const type of ['line', 'arrow']) for (const lineStyle of LINE_STYLES) {
    const board = applyOperations(emptyBoard('style'), [{ op: 'add', id: 'edge', type, x: -40, y: -20, width: 180, height: 80, lineStyle }]);
    const edge = find(board, 'edge');
    assert.deepEqual(edge.points[0], [0, 0]);
    assert.deepEqual(edge.points.at(-1), [180, 80]);
    assert.deepEqual(edge.roundness, lineStyle === 'curved' ? { type: 2 } : null);
    if (type === 'arrow') assert.equal(edge.elbowed, false);
    assert.equal(edge.type, type);
    assert.deepEqual(validateScene(JSON.parse(JSON.stringify(board))).elements, board.elements);
    const changed = applyOperations(board, [{ op: 'update', id: 'edge', lineStyle: 'straight' }]);
    assert.deepEqual(find(changed, 'edge').points, [[0, 0], [180, 80]]);
    assert.ok(find(changed, 'edge').version > edge.version);
  }
});

test('explicit negative relative coordinates and manual multi-waypoints survive curved/polyline styles', () => {
  const points = [[-30, 20], [-120, -60], [80, 140], [160, -20]];
  for (const type of ['line', 'arrow']) for (const lineStyle of ['curved', 'polyline']) {
    const board = applyOperations(emptyBoard('style'), [{ op: 'add', id: 'edge', type, x: -100, y: 60, points, lineStyle }]);
    const edge = find(board, 'edge');
    assert.equal(edge.x, -100); assert.equal(edge.y, 60);
    assert.deepEqual(edge.points, points);
    assert.equal(edge.width, 280); assert.equal(edge.height, 200);
    const updated = applyOperations(board, [{ op: 'update', id: 'edge', lineStyle: lineStyle === 'curved' ? 'polyline' : 'curved' }]);
    assert.deepEqual(find(updated, 'edge').points, points);
    const straight = applyOperations(updated, [{ op: 'update', id: 'edge', lineStyle: 'straight' }]);
    assert.deepEqual(find(straight, 'edge').points, [points[0], points.at(-1)]);
  }
});

test('omitting lineStyle preserves existing default geometry and does not restyle nodes', () => {
  const points = [[0, 0], [-20, 70], [200, 10]];
  const board = applyOperations(emptyBoard('style'), [
    { op: 'add', id: 'edge', type: 'line', points },
    { op: 'add', id: 'node', type: 'rectangle', text: 'Node' },
  ]);
  assert.deepEqual(find(board, 'edge').points, points);
  assert.equal(find(board, 'edge').roundness, null);
  const styled = applyOperations(board, [{ op: 'update', id: 'edge', lineStyle: 'curved' }]);
  assert.deepEqual(find(styled, 'node'), find(board, 'node'));
  const moved = applyOperations(styled, [{ op: 'update', id: 'edge', x: 100, strokeColor: '#f00' }]);
  assert.deepEqual(find(moved, 'edge').points, points);
  assert.deepEqual(find(moved, 'edge').roundness, { type: 2 });
  const replaced = applyOperations(moved, [{ op: 'update', id: 'edge', points: [[10, 5], [-40, 80]] }]);
  assert.deepEqual(find(replaced, 'edge').points, [[10, 5], [-40, 80]]);
  assert.deepEqual(find(replaced, 'edge').roundness, { type: 2 });
});

test('styles respect sequential batch semantics and generate only after binding endpoints', () => {
  const board = applyOperations(emptyBoard('style'), [
    { op: 'add', id: 'a', type: 'rectangle', x: 10, y: 20 },
    { op: 'add', id: 'b', type: 'rectangle', x: 500, y: 200 },
    { op: 'add', id: 'edge', type: 'arrow', startId: 'a', endId: 'b', lineStyle: 'curved' },
  ]);
  const defaultEdge = find(applyOperations(emptyBoard('style'), [
    { op: 'add', id: 'a', type: 'rectangle', x: 10, y: 20 },
    { op: 'add', id: 'b', type: 'rectangle', x: 500, y: 200 },
    { op: 'add', id: 'edge', type: 'arrow', startId: 'a', endId: 'b' },
  ]), 'edge');
  assert.deepEqual(find(board, 'edge').points, styleLinearElement(defaultEdge, 'curved').points);
  const points = [[0, 0], [10, -50], [100, 100]];
  const sequential = applyOperations(emptyBoard('style'), [
    { op: 'add', id: 'edge', type: 'line', points, lineStyle: 'straight' },
    { op: 'update', id: 'edge', points },
  ]);
  assert.deepEqual(find(sequential, 'edge').points, points);
  assert.equal(find(sequential, 'edge').roundness, null);
});

test('lineStyle validation rejects null, unsupported styles, nodes and deletion atomically', () => {
  const board = diagram(), before = structuredClone(board);
  for (const lineStyle of [null, true, 1, [], {}, 'elbow', 'Curved']) {
    rejected(() => validateOperations([{ op: 'update', id: 'edge', lineStyle }]));
    rejected(() => applyOperations(board, [{ op: 'update', id: 'edge', lineStyle }]));
  }
  for (const type of ['rectangle', 'ellipse', 'diamond', 'text']) rejected(() => applyOperations(board, [{ op: 'add', id: 'new', type, lineStyle: 'curved' }]));
  rejected(() => applyOperations(board, [{ op: 'update', id: 'a', lineStyle: 'polyline' }]));
  rejected(() => validateOperations([{ op: 'delete', id: 'edge', lineStyle: 'straight' }]));
  rejected(() => applyOperations(board, [{ op: 'update', id: 'edge', lineStyle: 'curved', points: null }]));
  rejected(() => applyOperations(board, [{ op: 'update', id: 'edge', lineStyle: 'curved' }, { op: 'update', id: 'a', lineStyle: 'polyline' }]));
  assert.deepEqual(board, before);
});

test('bound curved and polyline arrows preserve manual controls and labels when nodes move or delete', () => {
  for (const lineStyle of ['curved', 'polyline']) {
    const board = applyOperations(diagram(), [{ op: 'update', id: 'edge', lineStyle }]);
    const before = find(board, 'edge');
    const absoluteControls = before.points.slice(1, -1).map(([x, y]) => [before.x + x, before.y + y]);
    const moved = applyOperations(board, [{ op: 'update', id: 'a', x: -100, y: 200 }, { op: 'update', id: 'b', x: 600, y: -50 }]);
    const arrow = find(moved, 'edge'), label = find(moved, 'edge__label');
    assert.deepEqual(arrow.points.slice(1, -1).map(([x, y]) => [arrow.x + x, arrow.y + y]), absoluteControls);
    assert.notDeepEqual([arrow.x, arrow.y], [before.x, before.y]);
    assert.deepEqual(arrow.roundness, before.roundness);
    assert.equal(arrow.startBinding.elementId, 'a'); assert.equal(arrow.endBinding.elementId, 'b');
    assert.equal(arrow.elbowed, false);
    const [x, y] = linearPathMidpoint(arrow);
    assert.equal(label.x + label.width / 2, x); assert.equal(label.y + label.height / 2, y);
    assert.doesNotThrow(() => validateScene(moved));
    const deleted = applyOperations(moved, [{ op: 'delete', id: 'a' }]);
    assert.equal(find(deleted, 'edge').isDeleted, true); assert.equal(find(deleted, 'edge__label').isDeleted, true);
    assert.equal(find(deleted, 'edge').startBinding, null); assert.equal(find(deleted, 'edge').endBinding, null);
    assert.doesNotThrow(() => validateScene(deleted));
  }
});

test('binding a styled arrow or restyling after node movement keeps coherent bound endpoints', () => {
  for (const lineStyle of ['straight', 'curved', 'polyline']) {
    const board = applyOperations(diagram(), [
      { op: 'update', id: 'a', x: -100, y: 200 },
      { op: 'update', id: 'edge', points: [[0, 0], [100, 0]], lineStyle },
    ]);
    const arrow = find(board, 'edge');
    assert.equal(arrow.startBinding.elementId, 'a'); assert.equal(arrow.endBinding.elementId, 'b');
    assert.ok(arrow.x > -100 && arrow.x < 400);
    assert.notDeepEqual(arrow.points.at(-1), [100, 0]);
    assert.equal(arrow.points.length >= 3, lineStyle !== 'straight');
    assert.deepEqual(arrow.roundness, lineStyle === 'curved' ? { type: 2 } : null);
  }
});

test('restyling a rotated bound native arrow preserves world endpoints and controls before node movement', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} ≈ ${b}`);
  for (const sourceStyle of ['polyline', 'curved']) for (const lineStyle of LINE_STYLES) {
    const board = diagram(), arrow = find(board, 'edge');
    const world = linearWorldPoints(arrow);
    world.splice(1, 0, [(world[0][0] + world.at(-1)[0]) / 2, world[0][1] - 100]);
    const angle = 0.7, cos = Math.cos(angle), sin = Math.sin(angle), first = world[0];
    const points = world.map(([x, y]) => [cos * (x - first[0]) + sin * (y - first[1]), -sin * (x - first[0]) + cos * (y - first[1])]);
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    Object.assign(arrow, { angle, points, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
      x: first[0] + (cos - 1) * cx - sin * cy, y: first[1] + sin * cx + (cos - 1) * cy });
    if (sourceStyle === 'curved') Object.assign(arrow, styleLinearElement(arrow, 'curved'));
    const snapshot = structuredClone(board);
    const styled = applyOperations(board, [{ op: 'update', id: 'edge', lineStyle }]), edge = find(styled, 'edge');
    const after = linearWorldPoints(edge);
    for (const index of [0, -1]) { near(after.at(index)[0], world.at(index)[0]); near(after.at(index)[1], world.at(index)[1]); }
    assert.equal(edge.angle, 0);
    assert.equal(edge.startBinding.elementId, 'a'); assert.equal(edge.endBinding.elementId, 'b');
    if (lineStyle !== 'straight') { near(after[1][0], world[1][0]); near(after[1][1], world[1][1]); }
    const moved = applyOperations(styled, [{ op: 'update', id: 'a', y: 240 }]), movedWorld = linearWorldPoints(find(moved, 'edge'));
    if (lineStyle !== 'straight') { near(movedWorld[1][0], world[1][0]); near(movedWorld[1][1], world[1][1]); }
    assert.equal(find(moved, 'edge').startBinding.elementId, 'a');
    assert.doesNotThrow(() => validateScene(moved));
    assert.deepEqual(board, snapshot);
  }
});

test('native elbow arrow conversion is validated, detached and cleans fixed routing metadata', () => {
  const board = diagram(), native = find(board, 'edge');
  native.elbowed = true; native.fixedSegments = [{ index: 1, start: [0, 0], end: [100, 0] }];
  native.startIsSpecial = true; native.endIsSpecial = true;
  native.startBinding.fixedPoint = [1, 0.5]; native.endBinding.fixedPoint = [0, 0.5];
  const snapshot = structuredClone(board);
  for (const lineStyle of LINE_STYLES) {
    const next = applyOperations(board, [{ op: 'update', id: 'edge', lineStyle }]), edge = find(next, 'edge');
    assert.equal(edge.elbowed, false); assert.equal(edge.fixedSegments, null);
    assert.equal(edge.startIsSpecial, false); assert.equal(edge.endIsSpecial, false);
    assert.equal(edge.startBinding.fixedPoint, null); assert.equal(edge.endBinding.fixedPoint, null);
    assert.equal(edge.startBinding.elementId, 'a'); assert.equal(edge.endBinding.elementId, 'b');
    assert.deepEqual(validateScene(next).elements, next.elements);
  }
  assert.deepEqual(board, snapshot);
});

test('scene enforces element count and UTF-8 JSON byte limits', () => {
  rejected(() => validateScene(scene(Array.from({ length: 2001 }, (_, i) => shape(`n${i}`)))));
  rejected(() => validateScene({ ...scene(), large: 'x'.repeat(MAX_SCENE_BYTES) }));
  rejected(() => validateScene({ ...scene(), large: '中'.repeat(Math.ceil(MAX_SCENE_BYTES / 3)) }));
});
