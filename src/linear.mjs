/** Browser-safe geometry shared by native selection tools and the backend model. */
export const LINE_STYLES = ['straight', 'curved', 'polyline'];

function linearPoints(element) {
  if (!element || !['line', 'arrow'].includes(element.type)) throw new TypeError('Expected a line or arrow');
  if (!Array.isArray(element.points) || element.points.length < 2 || element.points.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
    throw new TypeError('Linear elements require at least two finite [x,y] points');
  }
  return element.points;
}
function bounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}
function bendSize(length) { return Math.max(32, Math.min(120, length / 4)); }
function curvedPoints(points) {
  const first = points[0];
  const distinct = points.find(point => point[0] !== first[0] || point[1] !== first[1]);
  if (distinct) {
    const dx = distinct[0] - first[0], dy = distinct[1] - first[1];
    const length = Math.hypot(dx, dy);
    // Keep every existing control point when the path is already visibly curved.
    if (points.some(point => Math.abs((point[0] - first[0]) * dy / length - (point[1] - first[1]) * dx / length) > 1e-7)) return points;
    // Collinear multi-point input also needs a bend; insert, never move, its controls.
    if (points.length >= 20000) throw new RangeError('Curving this path would exceed 20000 points; remove a waypoint first');
    let index = 1, longest = 0;
    for (let i = 1; i < points.length; i++) {
      const distance = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      if (distance > longest) { longest = distance; index = i; }
    }
    const a = points[index - 1], b = points[index], bend = bendSize(longest);
    const middle = [(a[0] + b[0]) / 2 - (b[1] - a[1]) / longest * bend, (a[1] + b[1]) / 2 + (b[0] - a[0]) / longest * bend];
    return [...points.slice(0, index), middle, ...points.slice(index)];
  }
  // Coincident endpoints cannot form a non-collinear three-point curve: use a loop.
  if (points.length > 19998) throw new RangeError('Curving this path would exceed 20000 points; remove a waypoint first');
  return [first, [first[0] + 32, first[1] - 32], [first[0] + 32, first[1] + 32], ...points.slice(1)];
}
function polylinePoints(points) {
  if (points.length > 2) return points;
  const [a, b] = points, dx = b[0] - a[0], dy = b[1] - a[1];
  const bend = bendSize(Math.hypot(dx, dy));
  if (dx === 0 && dy === 0) return [a, [a[0] + bend, a[1]], [a[0] + bend, a[1] + bend], [a[0], a[1] + bend], b];
  if (dy === 0) return [a, [a[0], a[1] + bend], [b[0], b[1] + bend], b];
  if (dx === 0) return [a, [a[0] + bend, a[1]], [b[0] + bend, b[1]], b];
  if (Math.abs(dx) >= Math.abs(dy)) {
    const x = (a[0] + b[0]) / 2;
    return [a, [x, a[1]], [x, b[1]], b];
  }
  const y = (a[1] + b[1]) / 2;
  return [a, [a[0], y], [b[0], y], b];
}

/**
 * Return a detached native editable element, retaining relative point coordinates.
 * Never bumps versions. Ordinary multi-point arrows deliberately do not auto-route.
 */
export function styleLinearElement(element, lineStyle) {
  linearPoints(element);
  if (!LINE_STYLES.includes(lineStyle)) throw new TypeError('Unsupported lineStyle');
  const next = structuredClone(element);
  if (lineStyle === 'straight') next.points = [next.points[0], next.points.at(-1)];
  else if (lineStyle === 'curved') next.points = curvedPoints(next.points);
  else next.points = polylinePoints(next.points);
  next.roundness = lineStyle === 'curved' ? { type: 2 } : null;
  const [minX, minY, maxX, maxY] = bounds(next.points);
  next.width = maxX - minX; next.height = maxY - minY;
  next.lastCommittedPoint = null;
  if (next.angle) {
    // Excalidraw rotates about its path bounds, not the element origin. A new
    // bend changes that pivot: compensate the origin, retaining world endpoints.
    const before = pathBounds(element), after = pathBounds({ ...next, elbowed: false });
    const dx = (after[0] + after[2] - before[0] - before[2]) / 2;
    const dy = (after[1] + after[3] - before[1] - before[3]) / 2;
    const cos = Math.cos(next.angle), sin = Math.sin(next.angle);
    next.x += (cos - 1) * dx - sin * dy;
    next.y += sin * dx + (cos - 1) * dy;
  }
  if (next.type === 'arrow') {
    // Explicit clearing also works when applied via Excalidraw's spreading newElementWith.
    next.elbowed = false;
    next.fixedSegments = null;
    next.startIsSpecial = false;
    next.endIsSpecial = false;
    for (const side of ['startBinding', 'endBinding']) {
      if (next[side] && Object.hasOwn(next[side], 'fixedPoint')) next[side].fixedPoint = null;
    }
  }
  return next;
}

// RoughJS' ideal curve is Catmull-Rom with repeated endpoint controls (tightness 0).
function segment(points, index) {
  const a = points[index], b = points[index + 1];
  const before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 2)];
  return [a, [a[0] + (b[0] - before[0]) / 6, a[1] + (b[1] - before[1]) / 6],
    [b[0] + (a[0] - after[0]) / 6, b[1] + (a[1] - after[1]) / 6], b];
}
function cubic(controls, t) {
  const u = 1 - t;
  return [0, 1].map(axis => u ** 3 * controls[0][axis] + 3 * u ** 2 * t * controls[1][axis] + 3 * u * t ** 2 * controls[2][axis] + t ** 3 * controls[3][axis]);
}
function curveBounds(points) {
  const extremes = [...points];
  for (let i = 0; i < points.length - 1; i++) {
    const controls = segment(points, i);
    for (let axis = 0; axis < 2; axis++) {
      const [a, b, c, d] = controls.map(point => point[axis]);
      const qa = -a + 3 * b - 3 * c + d, qb = 2 * (a - 2 * b + c), qc = b - a;
      const discriminant = qb * qb - 4 * qa * qc;
      const roots = Math.abs(qa) < 1e-12 ? (Math.abs(qb) < 1e-12 ? [] : [-qc / qb])
        : discriminant < 0 ? [] : [(-qb + Math.sqrt(discriminant)) / (2 * qa), (-qb - Math.sqrt(discriminant)) / (2 * qa)];
      for (const t of roots) if (t > 0 && t < 1) extremes.push(cubic(controls, t));
    }
  }
  return bounds(extremes);
}
function pathBounds(element) {
  return element.roundness && !element.elbowed && element.points.length > 2 ? curveBounds(element.points) : bounds(element.points);
}
function absolutePoint(element, point, localBounds) {
  const x = element.x + point[0], y = element.y + point[1];
  if (!element.angle) return [x, y];
  const [minX, minY, maxX, maxY] = localBounds ?? pathBounds(element);
  const cx = element.x + (minX + maxX) / 2, cy = element.y + (minY + maxY) / 2;
  const cos = Math.cos(element.angle), sin = Math.sin(element.angle);
  return [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
}

/** Detached ideal world-space controls, useful when rebinding a rotated arrow. */
export function linearWorldPoints(element) {
  const points = linearPoints(element), localBounds = element.angle ? pathBounds(element) : null;
  return points.map(point => absolutePoint(element, point, localBounds));
}

function segmentCenter(controls) {
  const samples = [controls[0]], distances = [0];
  for (let i = 1; i <= 64; i++) {
    const point = cubic(controls, i / 64), previous = samples.at(-1);
    samples.push(point);
    distances.push(distances.at(-1) + Math.hypot(point[0] - previous[0], point[1] - previous[1]));
  }
  const half = distances.at(-1) / 2;
  for (let i = 1; i < samples.length; i++) {
    if (distances[i] >= half) {
      const length = distances[i] - distances[i - 1];
      const fraction = length === 0 ? 0 : (half - distances[i - 1]) / length;
      return cubic(controls, (i - 1 + fraction) / 64);
    }
  }
  return controls[0];
}

/**
 * Absolute center-on-path for a native bound label: middle control for odd point
 * counts, middle segment's half-length for even counts, not half the whole route.
 * Curves/rotation use ideal (non-jittered) RoughJS geometry, not its random stroke.
 */
export function linearPathMidpoint(element) {
  const points = linearPoints(element), index = Math.floor(points.length / 2);
  const curved = !!element.roundness && !element.elbowed && points.length > 2;
  const point = points.length % 2 ? points[index]
    : curved ? segmentCenter(segment(points, index - 1))
      : [(points[index - 1][0] + points[index][0]) / 2, (points[index - 1][1] + points[index][1]) / 2];
  return absolutePoint(element, point);
}
