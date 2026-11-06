import React, { useId } from 'react';
import { readingNeighborhood, readingOutline, readingClip } from './reading.mjs';

// A pointer-transparent, view-only SVG. No element is restyled or replaced in the
// editor: native scene, exports, undo and the shared CAS baseline stay untouched.
export function ReadingOverlay({ elements, focusId, viewport }) {
  const clipPrefix = `reading-${useId().replace(/:/g, '_')}`;
  const neighborhood = readingNeighborhood(elements, focusId);
  if (!neighborhood.focusId) return null;
  const ids = new Set(neighborhood.highlightIds), edges = new Set(neighborhood.edgeIds);
  const zoom = viewport.zoom || 1;
  const shapes = elements.filter(element => ids.has(element.id)).map((element, i) => ({ element, outline: readingOutline(element), clip: readingClip(element, elements, { enabled: viewport.frameEnabled, clip: viewport.frameClip }), clipId: `${clipPrefix}-${i}` }));
  return <svg className="dsh-wb-reading-overlay" aria-hidden="true" data-reading-focus={neighborhood.focusId}>
    <g transform={`translate(${viewport.scrollX * zoom} ${viewport.scrollY * zoom}) scale(${zoom})`}>
      <defs>{shapes.filter(shape => shape.clip).map(({ element, clip, clipId }) => <clipPath id={clipId} key={element.id} clipPathUnits="userSpaceOnUse"><path {...clip} /></clipPath>)}</defs>
      {shapes.map(({ element, outline, clip, clipId }) => {
        if (!outline) return null;
        const kind = element.id === neighborhood.focusId ? 'focus' : edges.has(element.id) ? 'edge' : 'neighbor';
        return <g key={element.id} data-reading-element={element.id} className={`dsh-wb-reading-${kind}`} clipPath={clip ? `url(#${clipId})` : undefined}>
          <path {...outline} className="dsh-wb-reading-halo" vectorEffect="non-scaling-stroke" />
          <path {...outline} className="dsh-wb-reading-stroke" vectorEffect="non-scaling-stroke" />
        </g>;
      })}
    </g>
  </svg>;
}
