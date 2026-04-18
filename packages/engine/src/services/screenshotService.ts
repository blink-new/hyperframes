/**
 * Screenshot Service
 *
 * BeginFrame-based deterministic screenshot capture and video frame injection.
 */

import { type Page } from "puppeteer-core";
import { type CaptureOptions } from "../types.js";
import { MEDIA_VISUAL_STYLE_PROPERTIES } from "@hyperframes/core";

export const cdpSessionCache = new WeakMap<Page, import("puppeteer-core").CDPSession>();

export async function getCdpSession(page: Page): Promise<import("puppeteer-core").CDPSession> {
  let client = cdpSessionCache.get(page);
  if (!client) {
    client = await page.createCDPSession();
    cdpSessionCache.set(page, client);
  }
  return client;
}

/**
 * BeginFrame result with screenshot data and damage detection.
 */
export interface BeginFrameResult {
  buffer: Buffer;
  hasDamage: boolean;
}

/**
 * Capture a frame using HeadlessExperimental.beginFrame.
 *
 * This is an atomic operation: one CDP call runs a single layout-paint-composite
 * cycle and returns the screenshot + hasDamage boolean. Replaces the separate
 * settle → screenshot pipeline with a single deterministic render cycle.
 *
 * Requires chrome-headless-shell with --enable-begin-frame-control and
 * --deterministic-mode flags.
 */
// Cache the last valid screenshot buffer per page for hasDamage=false frames.
// When Chrome reports no visual change, we reuse the previous frame rather than
// attempting Page.captureScreenshot (which times out in beginFrame mode since
// the compositor is paused).
const lastFrameCache = new WeakMap<Page, Buffer>();

const PENDING_FRAME_RETRIES = 5;

async function sendBeginFrame(
  client: import("puppeteer-core").CDPSession,
  params: Parameters<typeof client.send<"HeadlessExperimental.beginFrame">>[1],
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.send("HeadlessExperimental.beginFrame", params);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isPending = msg.includes("Another frame is pending");
      if (isPending && attempt < PENDING_FRAME_RETRIES) {
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
        continue;
      }
      if (isPending) {
        throw new Error(
          `[BeginFrame] Frame still pending after ${PENDING_FRAME_RETRIES} retries — CPU overloaded by parallel renders. ` +
            `Reduce concurrent renders or use --docker for isolation.`,
        );
      }
      throw err;
    }
  }
}

export async function beginFrameCapture(
  page: Page,
  options: CaptureOptions,
  frameTimeTicks: number,
  interval: number,
): Promise<BeginFrameResult> {
  const client = await getCdpSession(page);

  const isPng = options.format === "png";
  const screenshot = {
    format: isPng ? "png" : "jpeg",
    quality: isPng ? undefined : (options.quality ?? 80),
    optimizeForSpeed: true,
  } as const;

  const result = await sendBeginFrame(client, { frameTimeTicks, interval, screenshot });

  let buffer: Buffer;
  if (result.screenshotData) {
    buffer = Buffer.from(result.screenshotData, "base64");
    lastFrameCache.set(page, buffer);
  } else {
    const cached = lastFrameCache.get(page);
    if (cached) {
      buffer = cached;
    } else {
      // Frame 0 always has damage, so this path is near-unreachable.
      // Force a composite with a tiny time advance.
      const fallback = await sendBeginFrame(client, {
        frameTimeTicks: frameTimeTicks + 0.001,
        interval,
        screenshot,
      });
      buffer = fallback.screenshotData
        ? Buffer.from(fallback.screenshotData, "base64")
        : Buffer.alloc(0);
      if (buffer.length > 0) lastFrameCache.set(page, buffer);
    }
  }

  return {
    buffer,
    hasDamage: result.hasDamage,
  };
}

/**
 * Capture a screenshot using standard Page.captureScreenshot CDP call.
 * Fallback for environments where BeginFrame is unavailable (macOS, Windows).
 */
export async function pageScreenshotCapture(page: Page, options: CaptureOptions): Promise<Buffer> {
  const client = await getCdpSession(page);
  const format = options.format === "png" ? "png" : "jpeg";
  const result = await client.send("Page.captureScreenshot", {
    format,
    quality: format === "jpeg" ? (options.quality ?? 80) : undefined,
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
  });
  return Buffer.from(result.data, "base64");
}

/**
 * Capture a screenshot with transparent background (PNG + alpha channel).
 *
 * Used in the two-pass HDR compositing pipeline — captures DOM content
 * (text, graphics, SDR overlays) with transparency where the background shows,
 * so it can be overlaid on top of native HDR video frames in FFmpeg.
 *
 * Sets and restores the background color override on every call. For sessions
 * that capture many frames, prefer calling initTransparentBackground() once
 * at session init, then captureAlphaPng() per frame to avoid the 2× CDP
 * round-trip overhead.
 */
export async function captureScreenshotWithAlpha(
  page: Page,
  width: number,
  height: number,
): Promise<Buffer> {
  const client = await getCdpSession(page);
  // Force transparent background so the screenshot has a real alpha channel
  await client.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: false, // must be false to preserve alpha
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  // Restore opaque background for subsequent captures
  await client.send("Emulation.setDefaultBackgroundColorOverride", {});
  return Buffer.from(result.data, "base64");
}

/**
 * Set the page background to transparent once for a dedicated HDR DOM session.
 *
 * Call this once after session initialization. Then use captureAlphaPng() per
 * frame instead of captureScreenshotWithAlpha() to skip the per-frame CDP
 * background override round-trips.
 *
 * Only use on sessions that are exclusively dedicated to transparent capture
 * (e.g., the HDR two-pass DOM layer session) — the background will stay
 * transparent for the lifetime of the session.
 */
export async function initTransparentBackground(page: Page): Promise<void> {
  const client = await getCdpSession(page);
  await client.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
}

/**
 * Capture a transparent-background PNG screenshot without setting the
 * background color override. Requires initTransparentBackground() to have
 * been called once on this session.
 *
 * Faster than captureScreenshotWithAlpha() for per-frame use in the HDR
 * two-pass compositing loop.
 */
export async function captureAlphaPng(page: Page, width: number, height: number): Promise<Buffer> {
  const client = await getCdpSession(page);
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: false, // must be false to preserve alpha
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  return Buffer.from(result.data, "base64");
}

export async function injectVideoFramesBatch(
  page: Page,
  updates: Array<{ videoId: string; dataUri: string }>,
): Promise<void> {
  if (updates.length === 0) return;
  await page.evaluate(
    async (items: Array<{ videoId: string; dataUri: string }>, visualProperties: string[]) => {
      const pendingDecodes: Array<Promise<void>> = [];
      for (const item of items) {
        const video = document.getElementById(item.videoId) as HTMLVideoElement | null;
        if (!video) continue;

        let img = video.nextElementSibling as HTMLImageElement | null;
        const isNewImage = !img || !img.classList.contains("__render_frame__");
        const computedStyle = window.getComputedStyle(video);
        const computedOpacity = parseFloat(computedStyle.opacity) || 1;
        const sourceIsStatic = !computedStyle.position || computedStyle.position === "static";

        if (isNewImage) {
          img = document.createElement("img");
          img.classList.add("__render_frame__");
          img.id = `__render_frame_${item.videoId}__`;
          img.style.pointerEvents = "none";
          video.parentNode?.insertBefore(img, video.nextSibling);
        }
        if (!img) continue;

        // Always use absolute positioning so the <img> overlays the <video>
        // instead of flowing below it. With position:relative, both elements
        // stack vertically — the <img> lands below the video and gets clipped
        // by any overflow:hidden ancestor (e.g., border-radius wrappers).
        {
          const videoRect = video.getBoundingClientRect();
          const offsetLeft = Number.isFinite(video.offsetLeft) ? video.offsetLeft : 0;
          const offsetTop = Number.isFinite(video.offsetTop) ? video.offsetTop : 0;
          const offsetWidth = video.offsetWidth > 0 ? video.offsetWidth : videoRect.width;
          const offsetHeight = video.offsetHeight > 0 ? video.offsetHeight : videoRect.height;
          img.style.position = "absolute";
          img.style.inset = "auto";
          img.style.left = `${offsetLeft}px`;
          img.style.top = `${offsetTop}px`;
          img.style.right = "auto";
          img.style.bottom = "auto";
          img.style.width = `${offsetWidth}px`;
          img.style.height = `${offsetHeight}px`;
        }
        img.style.objectFit = computedStyle.objectFit;
        img.style.objectPosition = computedStyle.objectPosition;
        img.style.zIndex = computedStyle.zIndex;

        for (const property of visualProperties) {
          if (
            sourceIsStatic &&
            (property === "top" ||
              property === "left" ||
              property === "right" ||
              property === "bottom" ||
              property === "inset")
          ) {
            continue;
          }
          const value = computedStyle.getPropertyValue(property);
          if (value) {
            img.style.setProperty(property, value);
          }
        }
        img.decoding = "sync";
        img.src = item.dataUri;
        pendingDecodes.push(
          img
            .decode()
            .catch(() => undefined)
            .then(() => undefined),
        );
        img.style.opacity = String(computedOpacity);
        img.style.visibility = "visible";
        video.style.setProperty("visibility", "hidden", "important");
        video.style.setProperty("opacity", "0", "important");
        video.style.setProperty("pointer-events", "none", "important");
      }
      if (pendingDecodes.length > 0) {
        await Promise.all(pendingDecodes);
      }
    },
    updates,
    [...MEDIA_VISUAL_STYLE_PROPERTIES],
  );
}

export async function syncVideoFrameVisibility(
  page: Page,
  activeVideoIds: string[],
): Promise<void> {
  await page.evaluate((ids: string[]) => {
    const active = new Set(ids);
    const videos = Array.from(document.querySelectorAll("video[data-start]")) as HTMLVideoElement[];
    for (const video of videos) {
      const img = video.nextElementSibling as HTMLElement | null;
      const hasImg = img && img.classList.contains("__render_frame__");
      if (active.has(video.id)) {
        // Active video: show injected <img>, hide native <video>
        video.style.setProperty("visibility", "hidden", "important");
        video.style.setProperty("opacity", "0", "important");
        video.style.setProperty("pointer-events", "none", "important");
        if (hasImg) {
          img.style.visibility = "visible";
        }
      } else {
        // Inactive video: hide both
        video.style.removeProperty("display");
        video.style.setProperty("visibility", "hidden", "important");
        video.style.setProperty("opacity", "0", "important");
        video.style.setProperty("pointer-events", "none", "important");
        if (hasImg) {
          img.style.visibility = "hidden";
        }
      }
    }
  }, activeVideoIds);
}
