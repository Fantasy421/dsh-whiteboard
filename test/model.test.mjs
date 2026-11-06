import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, emptyBoard, MAX_SCENE_BYTES, validateScene } from '../src/model.mjs';

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

test('scene enforces element count and UTF-8 JSON byte limits', () => {
  rejected(() => validateScene(scene(Array.from({ length: 2001 }, (_, i) => shape(`n${i}`)))));
  rejected(() => validateScene({ ...scene(), large: 'x'.repeat(MAX_SCENE_BYTES) }));
  rejected(() => validateScene({ ...scene(), large: '中'.repeat(Math.ceil(MAX_SCENE_BYTES / 3)) }));
});
