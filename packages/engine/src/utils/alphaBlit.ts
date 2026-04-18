/**
 * Alpha Blit — in-memory PNG decode + alpha compositing over rgb48le HDR frames.
 *
 * Replaces per-frame FFmpeg spawns for the two-pass HDR compositing path.
 * Uses only Node.js built-ins (zlib) — no additional dependencies.
 */

import { inflateSync } from "zlib";

// ── PNG decoder ───────────────────────────────────────────────────────────────

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Shared PNG chunk parsing + filter reconstruction.
 *
 * Verifies the PNG signature, iterates chunks to collect IHDR metadata and IDAT
 * payloads, decompresses with zlib, and reconstructs all 5 PNG filter types.
 *
 * Returns the defiltered pixel bytes (no filter-type prefix bytes) along with
 * IHDR fields so callers can convert to their target pixel format.
 */
function decodePngRaw(
  buf: Buffer,
  caller: string,
): { width: number; height: number; bitDepth: number; colorType: number; rawPixels: Buffer } {
  // Verify PNG signature
  if (
    buf[0] !== 137 ||
    buf[1] !== 80 ||
    buf[2] !== 78 ||
    buf[3] !== 71 ||
    buf[4] !== 13 ||
    buf[5] !== 10 ||
    buf[6] !== 26 ||
    buf[7] !== 10
  ) {
    throw new Error(`${caller}: not a PNG file`);
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (pos + 12 <= buf.length) {
    const chunkLen = buf.readUInt32BE(pos);
    const chunkType = buf.toString("ascii", pos + 4, pos + 8);
    const chunkData = buf.subarray(pos + 8, pos + 8 + chunkLen);

    if (chunkType === "IHDR") {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8] ?? 0;
      colorType = chunkData[9] ?? 0;
    } else if (chunkType === "IDAT") {
      idatChunks.push(Buffer.from(chunkData));
    } else if (chunkType === "IEND") {
      break;
    }

    pos += 12 + chunkLen; // length(4) + type(4) + data(chunkLen) + crc(4)
  }

  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`${caller}: unsupported color type ${colorType} (expected 2=RGB or 6=RGBA)`);
  }

  // Bytes per pixel: channels x bytes-per-channel
  const channels = colorType === 6 ? 4 : 3;
  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;

  const compressed = Buffer.concat(idatChunks);
  const decompressed = inflateSync(compressed);

  // Reconstruct filtered rows into a flat pixel buffer (no filter bytes)
  const rawPixels = Buffer.allocUnsafe(height * stride);
  const prevRow = new Uint8Array(stride);
  const currRow = new Uint8Array(stride);

  let srcPos = 0;

  for (let y = 0; y < height; y++) {
    const filterType = decompressed[srcPos++] ?? 0;
    const rawRow = decompressed.subarray(srcPos, srcPos + stride);
    srcPos += stride;

    switch (filterType) {
      case 0: // None
        currRow.set(rawRow);
        break;
      case 1: // Sub
        for (let x = 0; x < stride; x++) {
          currRow[x] = ((rawRow[x] ?? 0) + (x >= bpp ? (currRow[x - bpp] ?? 0) : 0)) & 0xff;
        }
        break;
      case 2: // Up
        for (let x = 0; x < stride; x++) {
          currRow[x] = ((rawRow[x] ?? 0) + (prevRow[x] ?? 0)) & 0xff;
        }
        break;
      case 3: // Average
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
          const up = prevRow[x] ?? 0;
          currRow[x] = ((rawRow[x] ?? 0) + Math.floor((left + up) / 2)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
          const up = prevRow[x] ?? 0;
          const upLeft = x >= bpp ? (prevRow[x - bpp] ?? 0) : 0;
          currRow[x] = ((rawRow[x] ?? 0) + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`${caller}: unknown filter type ${filterType} at row ${y}`);
    }

    rawPixels.set(currRow, y * stride);
    prevRow.set(currRow);
  }

  return { width, height, bitDepth, colorType, rawPixels };
}

/**
 * Decode a PNG buffer to raw RGBA pixel data (8-bit per channel).
 *
 * Supports color type 6 (RGBA) and color type 2 (RGB) at 8-bit depth,
 * non-interlaced. Chrome's Page.captureScreenshot always emits this format.
 *
 * Returns a Uint8Array of width*height*4 bytes in RGBA order.
 */
export function decodePng(buf: Buffer): { width: number; height: number; data: Uint8Array } {
  const { width, height, bitDepth, colorType, rawPixels } = decodePngRaw(buf, "decodePng");

  if (bitDepth !== 8) {
    throw new Error(`decodePng: unsupported bit depth ${bitDepth} (expected 8)`);
  }

  const output = new Uint8Array(width * height * 4);

  if (colorType === 6) {
    // RGBA — copy directly
    output.set(rawPixels);
  } else {
    // RGB → RGBA: set alpha to 255
    for (let i = 0; i < width * height; i++) {
      output[i * 4 + 0] = rawPixels[i * 3 + 0] ?? 0;
      output[i * 4 + 1] = rawPixels[i * 3 + 1] ?? 0;
      output[i * 4 + 2] = rawPixels[i * 3 + 2] ?? 0;
      output[i * 4 + 3] = 255;
    }
  }

  return { width, height, data: output };
}

// ── 16-bit PNG decoder ────────────────────────────────────────────────────────

/**
 * Decode a 16-bit RGB PNG (from FFmpeg) to an rgb48le Buffer.
 *
 * FFmpeg's `-pix_fmt rgb48le -c:v png` produces 16-bit RGB PNGs.
 * PNG stores 16-bit values in big-endian; this function swaps to little-endian
 * for the streaming encoder's rgb48le input format.
 *
 * Supports colorType 2 (RGB) and 6 (RGBA) at 16-bit depth, non-interlaced.
 */
export function decodePngToRgb48le(buf: Buffer): { width: number; height: number; data: Buffer } {
  const { width, height, bitDepth, colorType, rawPixels } = decodePngRaw(buf, "decodePngToRgb48le");

  if (bitDepth !== 16) {
    throw new Error(`decodePngToRgb48le: unsupported bit depth ${bitDepth} (expected 16)`);
  }

  // 16-bit: 2 bytes per channel. RGB=6 bytes/pixel, RGBA=8 bytes/pixel
  const bpp = colorType === 6 ? 8 : 6;

  // Output: rgb48le = 3 channels x 2 bytes (LE) = 6 bytes/pixel
  const output = Buffer.allocUnsafe(width * height * 6);

  for (let y = 0; y < height; y++) {
    const dstBase = y * width * 6;
    const srcRowBase = y * width * bpp;
    for (let x = 0; x < width; x++) {
      const srcBase = srcRowBase + x * bpp;
      // PNG stores 16-bit as big-endian: [high, low]. Swap to little-endian: [low, high].
      output[dstBase + x * 6 + 0] = rawPixels[srcBase + 1] ?? 0; // R low
      output[dstBase + x * 6 + 1] = rawPixels[srcBase + 0] ?? 0; // R high
      output[dstBase + x * 6 + 2] = rawPixels[srcBase + 3] ?? 0; // G low
      output[dstBase + x * 6 + 3] = rawPixels[srcBase + 2] ?? 0; // G high
      output[dstBase + x * 6 + 4] = rawPixels[srcBase + 5] ?? 0; // B low
      output[dstBase + x * 6 + 5] = rawPixels[srcBase + 4] ?? 0; // B high
    }
  }

  return { width, height, data: output };
}

// ── sRGB → HDR color conversion ───────────────────────────────────────────────

/**
 * Build a 256-entry LUT: sRGB 8-bit value → HDR 16-bit signal value.
 *
 * Pipeline per channel: sRGB EOTF (decode gamma) → linear → HDR OETF → 16-bit.
 *
 * Note: converts the transfer function but not the color primaries (bt709 → bt2020).
 * For neutral/near-neutral content (text, UI) the gamut difference is negligible.
 */
function buildSrgbToHdrLut(transfer: "hlg" | "pq"): Uint16Array {
  const lut = new Uint16Array(256);

  // HLG OETF constants (Rec. 2100)
  const hlgA = 0.17883277;
  const hlgB = 1 - 4 * hlgA;
  const hlgC = 0.5 - hlgA * Math.log(4 * hlgA);

  // PQ (SMPTE 2084) OETF constants
  const pqM1 = 0.1593017578125;
  const pqM2 = 78.84375;
  const pqC1 = 0.8359375;
  const pqC2 = 18.8515625;
  const pqC3 = 18.6875;
  const pqMaxNits = 10000.0;
  const sdrNits = 203.0;

  for (let i = 0; i < 256; i++) {
    // sRGB EOTF: signal → linear (range 0–1, relative to SDR white)
    const v = i / 255;
    const linear = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

    let signal: number;
    if (transfer === "hlg") {
      signal =
        linear <= 1 / 12 ? Math.sqrt(3 * linear) : hlgA * Math.log(12 * linear - hlgB) + hlgC;
    } else {
      // PQ OETF: linear light (in SDR nits) → PQ signal
      const Lp = Math.max(0, (linear * sdrNits) / pqMaxNits);
      const Lm1 = Math.pow(Lp, pqM1);
      signal = Math.pow((pqC1 + pqC2 * Lm1) / (1.0 + pqC3 * Lm1), pqM2);
    }

    lut[i] = Math.min(65535, Math.round(signal * 65535));
  }

  return lut;
}

const SRGB_TO_HLG = buildSrgbToHdrLut("hlg");
const SRGB_TO_PQ = buildSrgbToHdrLut("pq");

/** Select the correct sRGB→HDR LUT for the given transfer function. */
export function getSrgbToHdrLut(transfer: "hlg" | "pq"): Uint16Array {
  return transfer === "pq" ? SRGB_TO_PQ : SRGB_TO_HLG;
}

// ── Alpha compositing ─────────────────────────────────────────────────────────

/**
 * Alpha-composite a DOM RGBA overlay (8-bit sRGB) onto an HDR canvas
 * (rgb48le) in-place.
 *
 * DOM pixels are converted from sRGB to the target HDR signal space (HLG or PQ)
 * before blending so the composited output is uniformly encoded. Without this
 * conversion, sRGB content appears orange/washed in HDR playback.
 *
 * @param domRgba   Raw RGBA pixel data from decodePng() — width*height*4 bytes
 * @param canvas    HDR canvas in rgb48le format — width*height*6 bytes, mutated in-place
 * @param width     Canvas width in pixels
 * @param height    Canvas height in pixels
 * @param transfer  HDR transfer function — selects the correct sRGB→HDR LUT
 */
export function blitRgba8OverRgb48le(
  domRgba: Uint8Array,
  canvas: Buffer,
  width: number,
  height: number,
  transfer: "hlg" | "pq" = "hlg",
): void {
  const pixelCount = width * height;
  const lut = getSrgbToHdrLut(transfer);

  for (let i = 0; i < pixelCount; i++) {
    const da = domRgba[i * 4 + 3] ?? 0;

    if (da === 0) {
      continue;
    } else if (da === 255) {
      const r16 = lut[domRgba[i * 4 + 0] ?? 0] ?? 0;
      const g16 = lut[domRgba[i * 4 + 1] ?? 0] ?? 0;
      const b16 = lut[domRgba[i * 4 + 2] ?? 0] ?? 0;
      canvas.writeUInt16LE(r16, i * 6);
      canvas.writeUInt16LE(g16, i * 6 + 2);
      canvas.writeUInt16LE(b16, i * 6 + 4);
    } else {
      const alpha = da / 255;
      const invAlpha = 1 - alpha;

      const hdrR = (canvas[i * 6 + 0] ?? 0) | ((canvas[i * 6 + 1] ?? 0) << 8);
      const hdrG = (canvas[i * 6 + 2] ?? 0) | ((canvas[i * 6 + 3] ?? 0) << 8);
      const hdrB = (canvas[i * 6 + 4] ?? 0) | ((canvas[i * 6 + 5] ?? 0) << 8);

      const domR = lut[domRgba[i * 4 + 0] ?? 0] ?? 0;
      const domG = lut[domRgba[i * 4 + 1] ?? 0] ?? 0;
      const domB = lut[domRgba[i * 4 + 2] ?? 0] ?? 0;

      canvas.writeUInt16LE(Math.round(domR * alpha + hdrR * invAlpha), i * 6);
      canvas.writeUInt16LE(Math.round(domG * alpha + hdrG * invAlpha), i * 6 + 2);
      canvas.writeUInt16LE(Math.round(domB * alpha + hdrB * invAlpha), i * 6 + 4);
    }
  }
}

// ── Rounded-rectangle mask ───────────────────────────────────────────────────

/** Anti-aliased alpha for a point at distance `dist` from a corner circle of radius `r`. */
function cornerAlpha(px: number, py: number, cx: number, cy: number, r: number): number {
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > r + 0.5) return 0;
  if (dist > r - 0.5) return r + 0.5 - dist;
  return 1;
}

/**
 * Compute the alpha (0.0–1.0) for a point inside a rounded rectangle.
 * Returns 1.0 for interior pixels, 0.0 for exterior, and a smooth
 * transition at the corner edges (1px anti-aliasing).
 *
 * @param px     X coordinate (continuous, e.g. pixel center or subpixel)
 * @param py     Y coordinate
 * @param w      Rectangle width
 * @param h      Rectangle height
 * @param radii  Corner radii [topLeft, topRight, bottomRight, bottomLeft]
 */
export function roundedRectAlpha(
  px: number,
  py: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
): number {
  const [tl, tr, br, bl] = radii;
  if (px < tl && py < tl) return cornerAlpha(px, py, tl, tl, tl);
  if (px >= w - tr && py < tr) return cornerAlpha(px, py, w - tr, tr, tr);
  if (px >= w - br && py >= h - br) return cornerAlpha(px, py, w - br, h - br, br);
  if (px < bl && py >= h - bl) return cornerAlpha(px, py, bl, h - bl, bl);
  return 1;
}

// ── Positioned HDR region copy ────────────────────────────────────────────────

/**
 * Copy a rectangular region of an rgb48le source onto an rgb48le canvas
 * at position (dx, dy). Clips to canvas bounds. Optional opacity blending
 * (0.0–1.0) over existing canvas content.
 *
 * @param canvas  Destination rgb48le buffer (canvasWidth * canvasHeight * 6 bytes)
 * @param source  Source rgb48le buffer (sw * sh * 6 bytes)
 * @param dx      Destination X offset on canvas
 * @param dy      Destination Y offset on canvas
 * @param sw      Source width in pixels
 * @param sh      Source height in pixels
 * @param canvasWidth  Canvas width in pixels (needed for stride calculation)
 * @param opacity  Optional opacity 0.0–1.0 (default 1.0 = fully opaque copy)
 */
export function blitRgb48leRegion(
  canvas: Buffer,
  source: Buffer,
  dx: number,
  dy: number,
  sw: number,
  sh: number,
  canvasWidth: number,
  opacity?: number,
  borderRadius?: [number, number, number, number],
): void {
  if (sw <= 0 || sh <= 0) return;

  const op = opacity ?? 1.0;
  const canvasHeight = canvas.length / (canvasWidth * 6);

  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(canvasWidth, dx + sw);
  const y1 = Math.min(canvasHeight, dy + sh);
  if (x0 >= x1 || y0 >= y1) return;

  const clippedW = x1 - x0;
  const srcOffsetX = x0 - dx;
  const srcOffsetY = y0 - dy;

  const hasMask = borderRadius !== undefined;

  if (op >= 0.999 && !hasMask) {
    for (let y = 0; y < y1 - y0; y++) {
      const srcRowOff = ((srcOffsetY + y) * sw + srcOffsetX) * 6;
      const dstRowOff = ((y0 + y) * canvasWidth + x0) * 6;
      source.copy(canvas, dstRowOff, srcRowOff, srcRowOff + clippedW * 6);
    }
  } else {
    for (let y = 0; y < y1 - y0; y++) {
      for (let x = 0; x < clippedW; x++) {
        let effectiveOp = op;
        if (hasMask) {
          const ma = roundedRectAlpha(srcOffsetX + x, srcOffsetY + y, sw, sh, borderRadius);
          if (ma <= 0) continue;
          effectiveOp *= ma;
        }

        const srcOff = ((srcOffsetY + y) * sw + srcOffsetX + x) * 6;
        const dstOff = ((y0 + y) * canvasWidth + x0 + x) * 6;

        if (effectiveOp >= 0.999) {
          source.copy(canvas, dstOff, srcOff, srcOff + 6);
        } else {
          const invEff = 1 - effectiveOp;
          const sr = source.readUInt16LE(srcOff);
          const sg = source.readUInt16LE(srcOff + 2);
          const sb = source.readUInt16LE(srcOff + 4);
          const dr = canvas.readUInt16LE(dstOff);
          const dg = canvas.readUInt16LE(dstOff + 2);
          const db = canvas.readUInt16LE(dstOff + 4);
          canvas.writeUInt16LE(Math.round(sr * effectiveOp + dr * invEff), dstOff);
          canvas.writeUInt16LE(Math.round(sg * effectiveOp + dg * invEff), dstOff + 2);
          canvas.writeUInt16LE(Math.round(sb * effectiveOp + db * invEff), dstOff + 4);
        }
      }
    }
  }
}

/**
 * Apply a 2D affine transform to an rgb48le source and composite onto a canvas.
 *
 * For each destination pixel, the inverse transform maps back to source coordinates.
 * Bilinear interpolation samples the 4 nearest source pixels for smooth scaling/rotation.
 *
 * @param canvas     Destination rgb48le buffer, mutated in-place
 * @param source     Source rgb48le buffer (srcW * srcH * 6 bytes)
 * @param matrix     CSS transform matrix [a, b, c, d, tx, ty]
 * @param srcW       Source width in pixels
 * @param srcH       Source height in pixels
 * @param canvasW    Canvas width in pixels
 * @param canvasH    Canvas height in pixels
 * @param opacity    Optional opacity 0.0–1.0 (default 1.0)
 */
export function blitRgb48leAffine(
  canvas: Buffer,
  source: Buffer,
  matrix: number[],
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  opacity?: number,
  borderRadius?: [number, number, number, number],
): void {
  const a = matrix[0];
  const b = matrix[1];
  const c = matrix[2];
  const d = matrix[3];
  const tx = matrix[4];
  const ty = matrix[5];
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    tx === undefined ||
    ty === undefined
  )
    return;

  // Invert the 2x2 part of the affine matrix
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-10) return; // degenerate matrix

  const invA = d / det;
  const invB = -b / det;
  const invC = -c / det;
  const invD = a / det;
  const invTx = -(invA * tx + invC * ty);
  const invTy = -(invB * tx + invD * ty);

  const op = opacity ?? 1.0;

  const hasMask = borderRadius !== undefined;

  // Compute bounding box of transformed source on canvas
  const corners = [
    [tx, ty],
    [a * srcW + tx, b * srcW + ty],
    [c * srcH + tx, d * srcH + ty],
    [a * srcW + c * srcH + tx, b * srcW + d * srcH + ty],
  ];
  let minX = canvasW,
    maxX = 0,
    minY = canvasH,
    maxY = 0;
  for (const corner of corners) {
    const cx = corner[0] ?? 0;
    const cy = corner[1] ?? 0;
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  const startX = Math.max(0, Math.floor(minX));
  const endX = Math.min(canvasW, Math.ceil(maxX));
  const startY = Math.max(0, Math.floor(minY));
  const endY = Math.min(canvasH, Math.ceil(maxY));

  for (let dy = startY; dy < endY; dy++) {
    for (let dx = startX; dx < endX; dx++) {
      const sx = invA * dx + invC * dy + invTx;
      const sy = invB * dx + invD * dy + invTy;

      if (sx < 0 || sy < 0 || sx >= srcW || sy >= srcH) continue;

      // Apply rounded-rect mask in source coordinates
      let effectiveOp = op;
      if (hasMask) {
        const ma = roundedRectAlpha(sx, sy, srcW, srcH, borderRadius);
        if (ma <= 0) continue;
        effectiveOp *= ma;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);

      const off00 = (y0 * srcW + x0) * 6;
      const off10 = (y0 * srcW + x1) * 6;
      const off01 = (y1 * srcW + x0) * 6;
      const off11 = (y1 * srcW + x1) * 6;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const sr =
        source.readUInt16LE(off00) * w00 +
        source.readUInt16LE(off10) * w10 +
        source.readUInt16LE(off01) * w01 +
        source.readUInt16LE(off11) * w11;
      const sg =
        source.readUInt16LE(off00 + 2) * w00 +
        source.readUInt16LE(off10 + 2) * w10 +
        source.readUInt16LE(off01 + 2) * w01 +
        source.readUInt16LE(off11 + 2) * w11;
      const sb =
        source.readUInt16LE(off00 + 4) * w00 +
        source.readUInt16LE(off10 + 4) * w10 +
        source.readUInt16LE(off01 + 4) * w01 +
        source.readUInt16LE(off11 + 4) * w11;

      const dstOff = (dy * canvasW + dx) * 6;

      if (effectiveOp >= 0.999) {
        canvas.writeUInt16LE(Math.round(sr), dstOff);
        canvas.writeUInt16LE(Math.round(sg), dstOff + 2);
        canvas.writeUInt16LE(Math.round(sb), dstOff + 4);
      } else {
        const invEff = 1 - effectiveOp;
        const dr = canvas.readUInt16LE(dstOff);
        const dg = canvas.readUInt16LE(dstOff + 2);
        const db = canvas.readUInt16LE(dstOff + 4);
        canvas.writeUInt16LE(Math.round(sr * effectiveOp + dr * invEff), dstOff);
        canvas.writeUInt16LE(Math.round(sg * effectiveOp + dg * invEff), dstOff + 2);
        canvas.writeUInt16LE(Math.round(sb * effectiveOp + db * invEff), dstOff + 4);
      }
    }
  }
}

/**
 * Parse a CSS `matrix(a,b,c,d,e,f)` string into a 6-element array.
 * Returns null for "none", empty, or unsupported formats (matrix3d).
 *
 * The array maps to the CSS matrix: [a, b, c, d, tx, ty] where:
 *   | a  c  tx |     (a=scaleX, b=skewY, c=skewX, d=scaleY, tx/ty=translate)
 *   | b  d  ty |
 *   | 0  0  1  |
 */
export function parseTransformMatrix(css: string): number[] | null {
  if (!css || css === "none") return null;
  const match = css.match(
    /^matrix\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,)]+)\s*\)$/,
  );
  if (!match) return null;
  return match.slice(1, 7).map(Number);
}
