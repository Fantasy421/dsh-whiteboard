const TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'arrow', 'line', 'freedraw', 'image', 'frame']);
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** UI guard only. The host remains the authoritative scene/security validator. */
export function safeNativeInput(elements, files, selectedIds) {
  const safeFiles = Object.fromEntries(Object.entries(files).filter(([, file]) => MIME.has(file.mimeType)));
  const supported = element => TYPES.has(element.type) && (element.type !== 'image' || element.fileId == null || Object.hasOwn(safeFiles, element.fileId));
  const rejected = elements.some(element => !element.isDeleted && !supported(element));
  // Unsupported tombstones/unreferenced imported media must not poison all later saves.
  const safeElements = elements.filter(supported);
  const live = new Set(safeElements.filter(e => !e.isDeleted).map(e => e.id));
  return { rejected, scene: { elements: safeElements, files: safeFiles, selectedIds: selectedIds.filter(id => live.has(id)) } };
}
