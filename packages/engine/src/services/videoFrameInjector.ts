/**
 * Video Frame Injector
 *
 * Creates a BeforeCaptureHook that replaces native <video> elements with
 * pre-extracted frame images during rendering. This is the Hyperframes-specific
 * video handling strategy — OSS users with different video pipelines can
 * provide their own hook or skip video injection entirely.
 */

import { type Page } from "puppeteer-core";
import { promises as fs } from "fs";
import { type FrameLookupTable } from "./videoFrameExtractor.js";
import { injectVideoFramesBatch, syncVideoFrameVisibility } from "./screenshotService.js";
import { type BeforeCaptureHook } from "./frameCapture.js";
import { DEFAULT_CONFIG, type EngineConfig } from "../config.js";

function createFrameDataUriCache(cacheLimit: number) {
  const cache = new Map<string, string>();
  const inFlight = new Map<string, Promise<string>>();

  function remember(framePath: string, dataUri: string): string {
    if (cache.has(framePath)) {
      cache.delete(framePath);
    }
    cache.set(framePath, dataUri);
    if (cache.size > cacheLimit) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) {
        cache.delete(oldestKey);
      }
    }
    return dataUri;
  }

  async function get(framePath: string): Promise<string> {
    const cached = cache.get(framePath);
    if (cached) {
      remember(framePath, cached);
      return cached;
    }

    const existing = inFlight.get(framePath);
    if (existing) {
      return existing;
    }

    const pending = fs
      .readFile(framePath)
      .then((frameData) => {
        const mimeType = framePath.endsWith(".png") ? "image/png" : "image/jpeg";
        const dataUri = `data:${mimeType};base64,${frameData.toString("base64")}`;
        return remember(framePath, dataUri);
      })
      .finally(() => {
        inFlight.delete(framePath);
      });
    inFlight.set(framePath, pending);
    return pending;
  }

  return { get };
}

/**
 * Creates a BeforeCaptureHook that injects pre-extracted video frames
 * into the page, replacing native <video> elements with frame images.
 */
export function createVideoFrameInjector(
  frameLookup: FrameLookupTable | null,
  config?: Partial<Pick<EngineConfig, "frameDataUriCacheLimit">>,
): BeforeCaptureHook | null {
  if (!frameLookup) return null;

  const cacheLimit = Math.max(
    32,
    config?.frameDataUriCacheLimit ?? DEFAULT_CONFIG.frameDataUriCacheLimit,
  );
  const frameCache = createFrameDataUriCache(cacheLimit);
  const lastInjectedFrameByVideo = new Map<string, number>();

  return async (page: Page, time: number) => {
    const activePayloads = frameLookup.getActiveFramePayloads(time);

    const updates: Array<{ videoId: string; dataUri: string; frameIndex: number }> = [];
    const activeIds = new Set<string>();
    if (activePayloads.size > 0) {
      const pendingReads: Array<Promise<{ videoId: string; dataUri: string; frameIndex: number }>> =
        [];
      for (const [videoId, payload] of activePayloads) {
        activeIds.add(videoId);
        const lastFrameIndex = lastInjectedFrameByVideo.get(videoId);
        if (lastFrameIndex === payload.frameIndex) continue;
        pendingReads.push(
          frameCache
            .get(payload.framePath)
            .then((dataUri) => ({ videoId, dataUri, frameIndex: payload.frameIndex })),
        );
      }
      updates.push(...(await Promise.all(pendingReads)));
    }

    for (const videoId of Array.from(lastInjectedFrameByVideo.keys())) {
      if (!activeIds.has(videoId)) {
        lastInjectedFrameByVideo.delete(videoId);
      }
    }

    await syncVideoFrameVisibility(page, Array.from(activeIds));
    if (updates.length > 0) {
      await injectVideoFramesBatch(
        page,
        updates.map((u) => ({ videoId: u.videoId, dataUri: u.dataUri })),
      );
      for (const update of updates) {
        lastInjectedFrameByVideo.set(update.videoId, update.frameIndex);
      }
    }
  };
}

// ── HDR compositing utilities ─────────────────────────────────────────────────

/**
 * Bounds and transform of a video element, queried from Chrome each frame.
 * Used by the two-pass HDR compositing pipeline to position native HDR frames.
 */
export interface VideoElementBounds {
  videoId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  /** CSS transform matrix as a DOMMatrix-compatible string, e.g. "matrix(1,0,0,1,0,0)" */
  transform: string;
  zIndex: number;
  visible: boolean;
}

/**
 * Hide specific video elements by ID. Used in Pass 1 of the HDR pipeline so
 * Chrome screenshots only contain DOM content (text, overlays) with transparent
 * holes where the HDR videos go.
 */
export async function hideVideoElements(page: Page, videoIds: string[]): Promise<void> {
  if (videoIds.length === 0) return;
  await page.evaluate((ids: string[]) => {
    for (const id of ids) {
      const el = document.getElementById(id) as HTMLVideoElement | null;
      if (el) {
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("opacity", "0", "important");
        // Also hide the injected render frame image if present
        const img = document.getElementById(`__render_frame_${id}__`);
        if (img) img.style.setProperty("visibility", "hidden", "important");
      }
    }
  }, videoIds);
}

/**
 * Restore visibility of video elements after a DOM screenshot.
 */
export async function showVideoElements(page: Page, videoIds: string[]): Promise<void> {
  if (videoIds.length === 0) return;
  await page.evaluate((ids: string[]) => {
    for (const id of ids) {
      const el = document.getElementById(id) as HTMLVideoElement | null;
      if (el) {
        el.style.removeProperty("visibility");
        el.style.removeProperty("opacity");
        const img = document.getElementById(`__render_frame_${id}__`);
        if (img) img.style.removeProperty("visibility");
      }
    }
  }, videoIds);
}

/**
 * Query the current bounds, transform, and visibility of video elements.
 * Called after seeking (so GSAP has moved things) but before the screenshot.
 */
export async function queryVideoElementBounds(
  page: Page,
  videoIds: string[],
): Promise<VideoElementBounds[]> {
  if (videoIds.length === 0) return [];
  return page.evaluate((ids: string[]): VideoElementBounds[] => {
    return ids.map((id) => {
      const el = document.getElementById(id) as HTMLVideoElement | null;
      if (!el) {
        return {
          videoId: id,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          opacity: 0,
          transform: "none",
          zIndex: 0,
          visible: false,
        };
      }
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const zIndex = parseInt(style.zIndex) || 0;
      const opacity = parseFloat(style.opacity) || 1;
      const transform = style.transform || "none";
      const visible =
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0;
      return {
        videoId: id,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        opacity,
        transform,
        zIndex,
        visible,
      };
    });
  }, videoIds);
}

/**
 * Stacking info for a single timed element, used by the z-ordered layer compositor.
 */
export interface ElementStackingInfo {
  id: string;
  zIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Layout dimensions before CSS transforms (offsetWidth/offsetHeight). */
  layoutWidth: number;
  layoutHeight: number;
  opacity: number;
  visible: boolean;
  isHdr: boolean;
  transform: string; // CSS transform matrix string, e.g. "matrix(1,0,0,1,0,0)" or "none"
  borderRadius: [number, number, number, number]; // [tl, tr, br, bl] in CSS px from nearest clipping ancestor
}

/**
 * Query Chrome for ALL timed elements' stacking context.
 * Returns z-index, bounds, opacity, and whether each element is a native HDR video.
 *
 * Queries every element with `data-start` (not just videos) so the layer compositor
 * can determine z-ordering between DOM content and HDR video elements.
 */
export async function queryElementStacking(
  page: Page,
  nativeHdrVideoIds: Set<string>,
): Promise<ElementStackingInfo[]> {
  const hdrIds = Array.from(nativeHdrVideoIds);
  return page.evaluate((hdrIdList: string[]): ElementStackingInfo[] => {
    const hdrSet = new Set(hdrIdList);
    const elements = document.querySelectorAll("[data-start]");
    const results: ElementStackingInfo[] = [];

    // Walk up the DOM to find the effective z-index from the nearest
    // positioned ancestor with a z-index. CSS z-index only applies to
    // positioned elements; video elements inside positioned wrappers
    // inherit the wrapper's stacking context.
    function getEffectiveZIndex(node: Element): number {
      let current: Element | null = node;
      while (current) {
        const cs = window.getComputedStyle(current);
        const pos = cs.position;
        const z = parseInt(cs.zIndex);
        if (!Number.isNaN(z) && pos !== "static") return z;
        current = current.parentElement;
      }
      return 0;
    }

    // Find border-radius that clips the element. Replaced elements like <video>
    // clip to their own border-radius; ancestors need overflow !== visible.
    function getEffectiveBorderRadius(node: Element): [number, number, number, number] {
      // Resolve a CSS border-radius value to pixels. Chrome's getComputedStyle
      // returns percentages as-is (e.g. "50%"), not resolved to px.
      // Uses offsetWidth/offsetHeight (layout dimensions before CSS transforms)
      // because CSS resolves percentages against the padding box, not the
      // transformed bounding box.
      function resolveRadius(value: string, el: Element): number {
        if (value.includes("%")) {
          const pct = parseFloat(value) / 100;
          const htmlEl = el as HTMLElement;
          const w = htmlEl.offsetWidth || 0;
          const h = htmlEl.offsetHeight || 0;
          return pct * Math.min(w, h);
        }
        return parseFloat(value) || 0;
      }

      // Check element itself (replaced elements clip to own border-radius)
      const selfCs = window.getComputedStyle(node);
      const selfRadii: [number, number, number, number] = [
        resolveRadius(selfCs.borderTopLeftRadius, node),
        resolveRadius(selfCs.borderTopRightRadius, node),
        resolveRadius(selfCs.borderBottomRightRadius, node),
        resolveRadius(selfCs.borderBottomLeftRadius, node),
      ];
      if (selfRadii[0] > 0 || selfRadii[1] > 0 || selfRadii[2] > 0 || selfRadii[3] > 0) {
        return selfRadii;
      }

      // Walk ancestors looking for clipping container
      let current: Element | null = node.parentElement;
      while (current) {
        const cs = window.getComputedStyle(current);
        if (cs.overflow !== "visible") {
          const tl = resolveRadius(cs.borderTopLeftRadius, current);
          const tr = resolveRadius(cs.borderTopRightRadius, current);
          const brr = resolveRadius(cs.borderBottomRightRadius, current);
          const bl = resolveRadius(cs.borderBottomLeftRadius, current);
          if (tl > 0 || tr > 0 || brr > 0 || bl > 0) {
            return [tl, tr, brr, bl];
          }
        }
        current = current.parentElement;
      }
      return [0, 0, 0, 0];
    }

    // Walk up the DOM multiplying each ancestor's opacity. GSAP animates
    // opacity on wrapper divs, not directly on the video element, so the
    // element's own opacity is often 1.0. Multiplying ancestors gives the
    // true effective opacity.
    function getEffectiveOpacity(node: Element): number {
      let opacity = 1;
      let current: Element | null = node;
      while (current) {
        const cs = window.getComputedStyle(current);
        const val = parseFloat(cs.opacity);
        // Note: `val || 1` would turn opacity:0 into 1 (0 is falsy)
        opacity *= Number.isNaN(val) ? 1 : val;
        current = current.parentElement;
      }
      return opacity;
    }

    // Compute the full CSS transform matrix from element-local coords to
    // viewport coords by walking the offsetParent chain and accumulating
    // position offsets + CSS transforms. This correctly handles GSAP
    // animations on wrapper divs (rotation, scale) that getBoundingClientRect
    // conflates into an axis-aligned bounding box.
    function getViewportMatrix(node: Element): string {
      const chain: HTMLElement[] = [];
      let current: Element | null = node;
      while (current instanceof HTMLElement) {
        chain.push(current);
        current = current.offsetParent as Element | null;
      }
      let mat = new DOMMatrix();
      for (let i = chain.length - 1; i >= 0; i--) {
        const htmlEl = chain[i];
        if (!htmlEl) continue;
        mat = mat.translate(htmlEl.offsetLeft, htmlEl.offsetTop);
        const cs = window.getComputedStyle(htmlEl);
        if (cs.transform && cs.transform !== "none") {
          // Chrome's computed matrix does NOT include transform-origin.
          // CSS applies transforms as: translate(origin) * M * translate(-origin).
          // Parse the origin (defaults to "50% 50%") and wrap the matrix.
          const origin = cs.transformOrigin.split(" ");
          const ox = parseFloat(origin[0] || "0");
          const oy = parseFloat(origin[1] || "0");
          mat = mat.translate(ox, oy).multiply(new DOMMatrix(cs.transform)).translate(-ox, -oy);
        }
      }
      return mat.toString();
    }

    for (const el of elements) {
      const id = el.id;
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const zIndex = getEffectiveZIndex(el);
      // For HDR video elements, the frame injector sets `opacity: 0 !important`
      // on the element itself. Start the opacity walk from the parent to get the
      // real GSAP-animated opacity from wrapper divs.
      const isHdrEl = hdrSet.has(id);
      const opacityStartNode = isHdrEl ? el.parentElement : el;
      const opacity = opacityStartNode ? getEffectiveOpacity(opacityStartNode) : 1;
      const visible =
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0;
      const htmlEl = el as HTMLElement;
      results.push({
        id,
        zIndex,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        layoutWidth: htmlEl.offsetWidth || Math.round(rect.width),
        layoutHeight: htmlEl.offsetHeight || Math.round(rect.height),
        opacity,
        visible,
        isHdr: hdrSet.has(id),
        // For HDR elements, use the full accumulated viewport matrix so the
        // affine blit can apply rotation/scale/translate properly. For DOM
        // elements, the element-level transform is sufficient for reference.
        transform: isHdrEl ? getViewportMatrix(el) : style.transform || "none",
        borderRadius: isHdrEl ? getEffectiveBorderRadius(el) : [0, 0, 0, 0],
      });
    }
    return results;
  }, hdrIds);
}
