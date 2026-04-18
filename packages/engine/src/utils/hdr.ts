/**
 * HDR Color Space Utilities
 *
 * Centralized HDR detection, transfer type handling, and FFmpeg color
 * parameter generation for the HDR rendering pipeline.
 */

import type { VideoColorSpace } from "./ffprobe.js";

export type HdrTransfer = "hlg" | "pq";

/**
 * Check if a video's color space indicates HDR content.
 * Re-exported from videoFrameExtractor for backward compatibility.
 */
export function isHdrColorSpace(cs: VideoColorSpace | null): boolean {
  if (!cs) return false;
  return (
    cs.colorPrimaries.includes("bt2020") ||
    cs.colorSpace.includes("bt2020") ||
    cs.colorTransfer === "smpte2084" ||
    cs.colorTransfer === "arib-std-b67"
  );
}

/**
 * Determine the HDR transfer function from a video's color space metadata.
 * Returns "pq" for SMPTE 2084, "hlg" for ARIB STD-B67, or defaults to "hlg".
 */
export function detectTransfer(cs: VideoColorSpace | null): HdrTransfer {
  if (cs?.colorTransfer === "smpte2084") return "pq";
  return "hlg";
}

export interface HdrEncoderColorParams {
  colorPrimaries: string;
  colorTrc: string;
  colorspace: string;
  pixelFormat: string;
  x265ColorParams: string;
}

/**
 * Get FFmpeg encoder color parameters for a given HDR transfer function.
 */
export function getHdrEncoderColorParams(transfer: HdrTransfer): HdrEncoderColorParams {
  const colorTrc = transfer === "pq" ? "smpte2084" : "arib-std-b67";
  return {
    colorPrimaries: "bt2020",
    colorTrc,
    colorspace: "bt2020nc",
    pixelFormat: "yuv420p10le",
    x265ColorParams: `colorprim=bt2020:transfer=${colorTrc}:colormatrix=bt2020nc`,
  };
}

export interface CompositionHdrInfo {
  hasHdr: boolean;
  dominantTransfer: HdrTransfer | null;
}

/**
 * Analyze a set of video color spaces to determine if the composition
 * contains HDR content and what the dominant transfer function is.
 */
export function analyzeCompositionHdr(
  colorSpaces: Array<VideoColorSpace | null>,
): CompositionHdrInfo {
  let hasPq = false;
  let hasHdr = false;

  for (const cs of colorSpaces) {
    if (!isHdrColorSpace(cs)) continue;
    hasHdr = true;
    if (cs?.colorTransfer === "smpte2084") hasPq = true;
  }

  if (!hasHdr) return { hasHdr: false, dominantTransfer: null };

  // PQ takes priority — it's the more common HDR10 format
  const dominantTransfer: HdrTransfer = hasPq ? "pq" : "hlg";
  return { hasHdr: true, dominantTransfer };
}
