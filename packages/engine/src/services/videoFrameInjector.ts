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
