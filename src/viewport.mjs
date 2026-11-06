export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 30;

// Keep the scene point under the viewport center fixed while zooming.
export function zoomAtCenter(state, requestedZoom) {
  const value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, requestedZoom));
  const previous = state.zoom.value;
  return {
    zoom: { value },
    scrollX: state.scrollX + state.width / 2 * (1 / value - 1 / previous),
    scrollY: state.scrollY + state.height / 2 * (1 / value - 1 / previous),
  };
}
