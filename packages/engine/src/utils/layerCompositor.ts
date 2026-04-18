/**
 * Layer Compositor — z-order analysis for multi-layer HDR compositing.
 *
 * Groups timed elements into z-ordered layers (DOM or HDR) for the
 * per-frame compositing loop. Adjacent DOM elements merge into a single
 * layer to minimize Chrome screenshots.
 */

import type { ElementStackingInfo } from "../services/videoFrameInjector.js";

export type { ElementStackingInfo };

export type CompositeLayer =
  | { type: "dom"; elementIds: string[] }
  | { type: "hdr"; element: ElementStackingInfo };

/**
 * Group z-sorted elements into composite layers. Adjacent DOM elements
 * merge into a single layer. Each HDR video is its own layer.
 *
 * Elements are sorted by zIndex ascending (back to front) before grouping.
 * Invisible elements are filtered out.
 */
export function groupIntoLayers(elements: ElementStackingInfo[]): CompositeLayer[] {
  // Include ALL elements regardless of visibility. Video elements are hidden by
  // the frame injector (HEVC can't decode in headless Chrome) but their injected
  // <img> replacements ARE visible. We need them in the correct z-ordered layer
  // so they get hidden from other layers' DOM screenshots.
  const sorted = [...elements].sort((a, b) => a.zIndex - b.zIndex);

  const layers: CompositeLayer[] = [];

  for (const el of sorted) {
    if (el.isHdr) {
      layers.push({ type: "hdr", element: el });
    } else {
      const last = layers[layers.length - 1];
      if (last && last.type === "dom") {
        last.elementIds.push(el.id);
      } else {
        layers.push({ type: "dom", elementIds: [el.id] });
      }
    }
  }

  return layers;
}
