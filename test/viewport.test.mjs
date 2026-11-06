import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomAtCenter, MIN_ZOOM, MAX_ZOOM } from '../src/viewport.mjs';

test('zoom keeps the canvas-center scene point fixed, independent of sidebar offset', () => {
  const state = { width: 360, height: 640, offsetLeft: 900, offsetTop: 100, scrollX: -120, scrollY: 80, zoom: { value: 0.5 } };
  for (const value of [0.1, 1, 1.25, 3, 30]) {
    const next = zoomAtCenter(state, value);
    assert.ok(Math.abs(state.width / 2 / state.zoom.value - state.scrollX - (state.width / 2 / next.zoom.value - next.scrollX)) < 1e-8);
    assert.ok(Math.abs(state.height / 2 / state.zoom.value - state.scrollY - (state.height / 2 / next.zoom.value - next.scrollY)) < 1e-8);
    assert.equal(next.zoom.value, value);
    assert.deepEqual(Object.keys(next).sort(), ['scrollX', 'scrollY', 'zoom']);
  }
});

test('zoom clamps to the native supported limits and resets exactly to 100%', () => {
  const state = { width: 400, height: 600, scrollX: 0, scrollY: 0, zoom: { value: 1 } };
  assert.equal(zoomAtCenter(state, 0.001).zoom.value, MIN_ZOOM);
  assert.equal(zoomAtCenter(state, 100).zoom.value, MAX_ZOOM);
  assert.deepEqual(zoomAtCenter(state, 1), { zoom: { value: 1 }, scrollX: 0, scrollY: 0 });
});
