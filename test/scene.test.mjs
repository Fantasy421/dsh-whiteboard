import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNativeInput } from '../src/scene.mjs';
test('unsupported native input is rejected before changing sync state', () => {
  const value = safeNativeInput([{ id: 'embed', type: 'embeddable' }], {}, ['embed']);
  assert.equal(value.rejected, true); assert.equal(value.scene.elements.length, 0);
});
test('unsupported tombstones and unused SVG/GIF files cannot brick later saves', () => {
  const value = safeNativeInput([{ id: 'embed', type: 'embeddable', isDeleted: true }, { id: 'gif', type: 'image', fileId: 'gif', isDeleted: true }, { id: 'a', type: 'rectangle' }], { svg: { mimeType: 'image/svg+xml' }, gif: { mimeType: 'image/gif' }, png: { mimeType: 'image/png' } }, ['embed', 'a']);
  assert.equal(value.rejected, false); assert.deepEqual(value.scene.elements.map(e => e.id), ['a']);
  assert.deepEqual(Object.keys(value.scene.files), ['png']); assert.deepEqual(value.scene.selectedIds, ['a']);
});
test('live SVG/GIF images reject while supported raster images remain editable', () => {
  assert.equal(safeNativeInput([{ id: 'a', type: 'image', fileId: 'svg' }], { svg: { mimeType: 'image/svg+xml' } }, []).rejected, true);
  assert.equal(safeNativeInput([{ id: 'a', type: 'image', fileId: 'png' }], { png: { mimeType: 'image/png' } }, []).rejected, false);
});
