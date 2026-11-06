import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { LINE_STYLES, linearPathMidpoint, linearWorldPoints, styleLinearElement } from '../src/linear.mjs';
import { safeNativeInput } from '../src/scene.mjs';
import { applyOperations, emptyBoard } from '../src/model.mjs';

const line = (extra = {}) => ({
  id: 'edge', type: 'line', x: 10, y: -20, width: 200, height: 0,
  points: [[0, 0], [200, 0]], roundness: null, angle: 0,
  version: 7, versionNonce: 98, seed: 42, updated: 123,
  strokeColor: '#aabbcc', groupIds: ['group'], customData: { nested: ['retained'] }, ...extra,
});
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);
const noncollinear = points => {
  const a = points[0], b = points.find(point => point[0] !== a[0] || point[1] !== a[1]);
  return b && points.some(c => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 0);
};
const orthogonal = points => points.slice(1).every((point, index) => point[0] === points[index][0] || point[1] === points[index][1]);
const geometry = element => {
  assert.ok(element.points.every(point => point.every(Number.isFinite)));
  assert.ok(Number.isFinite(element.width) && Number.isFinite(element.height));
  assert.equal(element.width, Math.max(...element.points.map(point => point[0])) - Math.min(...element.points.map(point => point[0])));
  assert.equal(element.height, Math.max(...element.points.map(point => point[1])) - Math.min(...element.points.map(point => point[1])));
};

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('public style contract is browser-safe and rejects unsupported inputs', async () => {
  assert.deepEqual(LINE_STYLES, ['straight', 'curved', 'polyline']);
  for (const style of [null, undefined, false, 2, {}, [], 'elbow', 'CURVED']) assert.throws(() => styleLinearElement(line(), style), TypeError);
  for (const value of [null, {}, line({ type: 'rectangle' }), line({ points: null }), line({ points: [[0, 0]] }), line({ points: [[0, 0], [1, NaN]] })]) {
    assert.throws(() => styleLinearElement(value, 'curved'), TypeError);
    assert.throws(() => linearPathMidpoint(value), TypeError);
  }
  const result = await build({ entryPoints: [new URL('../src/linear.mjs', import.meta.url).pathname], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true });
  assert.deepEqual(Object.keys(result.metafile.inputs).map(path => path.split('/').at(-1)), ['linear.mjs']);
});

test('style conversion is fully detached and never changes identity or versions', () => {
  const input = freeze(line({ type: 'arrow', startBinding: { elementId: 'a', focus: 0.2, gap: 8 }, endBinding: null, boundElements: [{ id: 'label', type: 'text' }] }));
  const before = structuredClone(input);
  const next = styleLinearElement(input, 'curved');
  assert.deepEqual(input, before);
  for (const key of ['id', 'x', 'y', 'angle', 'version', 'versionNonce', 'seed', 'updated', 'strokeColor']) assert.deepEqual(next[key], input[key]);
  assert.deepEqual(next.startBinding, input.startBinding);
  assert.deepEqual(next.boundElements, input.boundElements);
  next.startBinding.gap = 100; next.boundElements[0].id = 'other'; next.groupIds.push('other'); next.customData.nested[0] = 'other';
  assert.deepEqual(input, before);
});

test('curved conversion bends horizontal, vertical, reversed and coincident endpoints', () => {
  for (const points of [[[0, 0], [200, 0]], [[0, 0], [0, 200]], [[-30, 25], [-120, -140]], [[3, 4], [3, 4]], [[0, 0], [0.00001, 0]]]) {
    const next = styleLinearElement(line({ points }), 'curved');
    assert.deepEqual(next.roundness, { type: 2 });
    assert.ok(next.points.length >= 3);
    assert.ok(noncollinear(next.points));
    assert.deepEqual(next.points[0], points[0]);
    assert.deepEqual(next.points.at(-1), points.at(-1));
    assert.equal(next.x, 10); assert.equal(next.y, -20);
    geometry(next);
  }
});

test('curves preserve existing controls and insert rather than overwrite collinear controls', () => {
  const points = [[-20, 5], [40, -90], [200, 30], [220, -60]];
  assert.deepEqual(styleLinearElement(line({ points }), 'curved').points, points);
  for (const collinear of [[[0, 0], [100, 0], [200, 0]], [[4, 5], [4, 5], [4, 5]], [[0, 0], [100, 100], [0, 0]]]) {
    const next = styleLinearElement(line({ points: collinear }), 'curved');
    assert.ok(noncollinear(next.points));
    let cursor = 0;
    for (const point of next.points) if (JSON.stringify(point) === JSON.stringify(collinear[cursor])) cursor++;
    assert.equal(cursor, collinear.length);
    geometry(next);
  }
});

test('curve generation refuses to exceed scene point limits without changing manual controls', () => {
  for (const points of [Array.from({ length: 20000 }, (_, x) => [x, 0]), Array.from({ length: 19999 }, () => [0, 0])]) {
    const input = line({ points }), before = structuredClone(input);
    assert.throws(() => styleLinearElement(input, 'curved'), { name: 'RangeError', message: /20000 points/ });
    assert.deepEqual(input, before);
    const board = { ...emptyBoard('limit'), elements: [input] }, snapshot = structuredClone(board);
    assert.throws(() => applyOperations(board, [{ op: 'update', id: 'edge', strokeColor: '#f00' }, { op: 'update', id: 'edge', lineStyle: 'curved' }]), { code: 'validation', message: /20000 points/ });
    assert.deepEqual(board, snapshot);
  }
  const noncollinear = Array.from({ length: 20000 }, (_, x) => [x, x % 2]);
  assert.deepEqual(styleLinearElement(line({ points: noncollinear }), 'curved').points, noncollinear);
  const largestCoincident = Array.from({ length: 19998 }, () => [0, 0]);
  assert.equal(styleLinearElement(line({ points: largestCoincident }), 'curved').points.length, 20000);
});

test('polyline endpoint conversion produces visible right-angle routes including axis and zero length cases', () => {
  for (const points of [[[0, 0], [200, 100]], [[0, 0], [100, 200]], [[0, 0], [200, 0]], [[0, 0], [0, -200]], [[-40, -20], [-190, -100]], [[8, 9], [8, 9]]]) {
    const next = styleLinearElement(line({ points }), 'polyline');
    assert.equal(next.roundness, null);
    assert.ok(next.points.length >= 3);
    assert.ok(orthogonal(next.points));
    assert.ok(noncollinear(next.points));
    assert.deepEqual(next.points[0], points[0]);
    assert.deepEqual(next.points.at(-1), points.at(-1));
    geometry(next);
  }
});

test('polyline keeps explicit multiple controls, even diagonal ones, and straight collapses only on request', () => {
  const points = [[-20, 30], [80, -100], [180, 90], [30, -20]];
  const polyline = styleLinearElement(line({ points }), 'polyline');
  assert.deepEqual(polyline.points, points);
  assert.equal(polyline.roundness, null);
  const straight = styleLinearElement(polyline, 'straight');
  assert.deepEqual(straight.points, [points[0], points.at(-1)]);
  assert.equal(straight.roundness, null);
  geometry(straight);
  const curved = styleLinearElement(straight, 'curved');
  assert.ok(noncollinear(curved.points));
  assert.deepEqual(styleLinearElement(curved, 'polyline').points, curved.points);
});

test('native elbow conversion clears auto-routing state even when spread over the original', () => {
  const input = freeze(line({
    type: 'arrow', elbowed: true, fixedSegments: [{ index: 1, start: [0, 0], end: [20, 0] }], startIsSpecial: true, endIsSpecial: true,
    startBinding: { elementId: 'node', focus: 0.5, gap: 8, fixedPoint: [1, 0.5] },
    endBinding: { elementId: 'other', focus: 0, gap: 4, fixedPoint: [0, 0.5] },
    startArrowhead: 'dot', endArrowhead: 'arrow', lastCommittedPoint: [200, 0],
  }));
  for (const style of LINE_STYLES) {
    const next = { ...input, ...styleLinearElement(input, style) };
    assert.equal(next.elbowed, false); assert.equal(next.fixedSegments, null);
    assert.equal(next.startIsSpecial, false); assert.equal(next.endIsSpecial, false);
    assert.equal(next.startBinding.fixedPoint, null); assert.equal(next.endBinding.fixedPoint, null);
    assert.equal(next.startBinding.elementId, 'node'); assert.equal(next.startBinding.focus, 0.5); assert.equal(next.startBinding.gap, 8);
    assert.equal(next.endBinding.elementId, 'other'); assert.equal(next.lastCommittedPoint, null);
    assert.equal(next.startArrowhead, 'dot'); assert.equal(next.endArrowhead, 'arrow');
  }
});

test('native input sanitizer retains editable curve and ordinary polyline fields', () => {
  for (const style of LINE_STYLES) {
    const element = styleLinearElement(line({ type: 'arrow', startBinding: null, endBinding: null }), style);
    const result = safeNativeInput([element], {}, ['edge']);
    assert.equal(result.rejected, false);
    assert.deepEqual(result.scene.elements, [element]);
  }
});

test('midpoint matches native middle-control convention instead of endpoint or route average', () => {
  assert.deepEqual(linearPathMidpoint(line()), [110, -20]);
  const odd = line({ points: [[0, 0], [40, 120], [200, 0]], roundness: { type: 2 } });
  assert.deepEqual(linearPathMidpoint(odd), [50, 100]);
  const even = line({ points: [[0, 0], [20, 100], [120, 100], [300, 0]] });
  assert.deepEqual(linearPathMidpoint(even), [80, 80]);
  const negative = line({ points: [[-40, 30], [-120, 30]], angle: 1.2 });
  const result = linearPathMidpoint(negative);
  near(result[0], -70); near(result[1], 10);
});

test('midpoint rotates around native point bounds and handles closed or degenerate paths', () => {
  const odd = line({ points: [[0, 0], [40, 120], [200, 0]], angle: Math.PI / 2 });
  const point = linearPathMidpoint(odd);
  near(point[0], 50); near(point[1], -20);
  const closed = line({ points: [[0, 0], [30, 0], [30, 40], [0, 40], [0, 0]] });
  assert.deepEqual(linearPathMidpoint(closed), [40, 20]);
  assert.deepEqual(linearPathMidpoint(line({ points: [[0, 0], [0, 0]] })), [10, -20]);
  const zeroCurve = line({ points: [[0, 0], [0, 0], [0, 0], [0, 0]], roundness: { type: 2 }, angle: 0.4 });
  assert.deepEqual(linearPathMidpoint(zeroCurve), [10, -20]);
});

test('rotated style roundtrips retain world endpoints while preserving angle and local controls', () => {
  for (const angle of [Math.PI / 2, -Math.PI / 3, 0.4]) for (const type of ['line', 'arrow']) {
    let current = line({ type, angle });
    const expected = linearWorldPoints(current);
    for (const style of ['curved', 'polyline', 'straight', 'polyline', 'curved', 'straight']) {
      const before = structuredClone(current);
      const next = styleLinearElement(current, style), world = linearWorldPoints(next);
      near(world[0][0], expected[0][0]); near(world[0][1], expected[0][1]);
      near(world.at(-1)[0], expected.at(-1)[0]); near(world.at(-1)[1], expected.at(-1)[1]);
      assert.equal(next.angle, angle); assert.equal(next.version, 7);
      assert.deepEqual(current, before);
      if (style === 'polyline' && current.points.length > 2) {
        const originalWorld = linearWorldPoints(current);
        for (let i = 0; i < world.length; i++) { near(world[i][0], originalWorld[i][0]); near(world[i][1], originalWorld[i][1]); }
      }
      current = next;
    }
  }
});

test('world control conversion uses native curve extrema for the rotation pivot and is detached', () => {
  const input = line({ points: [[0, 0], [30, 100], [130, 100], [160, 0]], roundness: { type: 2 }, angle: Math.PI / 2 });
  const points = linearWorldPoints(input);
  // Ideal native curve bounds are x=0..160,y=0..112.5, pivot=(90,36.25).
  near(points[0][0], 146.25); near(points[0][1], -43.75);
  near(points.at(-1)[0], 146.25); near(points.at(-1)[1], 116.25);
  points[0][0] = 999;
  assert.deepEqual(input.points[0], [0, 0]);
});

test('AI tool schema exposes optional styles and native summaries retain points/roundness/elbowed', async () => {
  const entry = new URL('../src/index.mjs', import.meta.url);
  const result = await build({ entryPoints: [entry.pathname], bundle: true, write: false, platform: 'node', format: 'esm',
    define: { 'import.meta.url': JSON.stringify(entry.href) },
    plugins: [{ name: 'test-host', setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-tools$/ }, () => ({ path: 'sdk', namespace: 'test-sdk' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-sdk' }, () => ({ contents: 'export const defineTool = tool => tool;', loader: 'js' }));
      builder.onResolve({ filter: /^node:fs\/promises$/ }, args => args.importer === entry.pathname ? { path: 'manifest', namespace: 'test-manifest' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'test-manifest' }, () => ({ contents: 'export const readFile = async () => "[]";', loader: 'js' }));
    } }],
  });
  const host = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const tools = new Map();
  await host.apply({ effect: effect => effect(), tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, connection: { fetch: { register() { return () => {}; } } } });
  const fields = tools.get('whiteboard_patch').parameters.operations.items.properties;
  assert.deepEqual(fields.lineStyle.enum, LINE_STYLES);
  assert.notEqual(fields.lineStyle.required, true);
  assert.match(fields.points.description, /relative/);
  assert.match(fields.points.description, /negative/);
  const board = applyOperations(emptyBoard('tools'), [{ op: 'add', id: 'edge', type: 'arrow', lineStyle: 'curved' }]);
  const summarized = host.summarize(board).elements[0];
  assert.deepEqual(summarized.points, board.elements[0].points);
  assert.deepEqual(summarized.roundness, { type: 2 });
  assert.equal(summarized.elbowed, false);
});

test('even curved midpoint follows the ideal native middle cubic, including rotated curves', () => {
  const points = [[0, 0], [30, 100], [130, 100], [160, 0]];
  const curve = line({ points, roundness: { type: 2 } });
  const center = linearPathMidpoint(curve);
  near(center[0], 90); near(center[1], 92.5);
  // Symmetry yields ideal curve y-extrema 0..112.5, hence center (80,56.25).
  const rotated = linearPathMidpoint({ ...curve, angle: Math.PI / 2 });
  near(rotated[0], 33.75); near(rotated[1], 36.25);
});
