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
 * Decode a PNG buffer to raw RGBA pixel data (8-bit per channel).
 *
 * Supports color type 6 (RGBA) and color type 2 (RGB) at 8-bit depth,
 * non-interlaced. Chrome's Page.captureScreenshot always emits this format.
 *
 * Returns a Uint8Array of width*height*4 bytes in RGBA order.
 */
export function decodePng(buf: Buffer): { width: number; height: number; data: Uint8Array } {
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
    throw new Error("decodePng: not a PNG file");
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

  if (bitDepth !== 8) {
    throw new Error(`decodePng: unsupported bit depth ${bitDepth} (expected 8)`);
  }
  // colorType 6 = RGBA, colorType 2 = RGB
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`decodePng: unsupported color type ${colorType} (expected 2=RGB or 6=RGBA)`);
  }

  const bpp = colorType === 6 ? 4 : 3; // bytes per pixel in the PNG stream
  const stride = width * bpp;

  const compressed = Buffer.concat(idatChunks);
  const decompressed = inflateSync(compressed);

  // Reconstruct filtered rows → output RGBA
  const output = new Uint8Array(width * height * 4);
  const prevRow = new Uint8Array(stride);
  const currRow = new Uint8Array(stride);

  let srcPos = 0;

  for (let y = 0; y < height; y++) {
    const filterType = decompressed[srcPos++] ?? 0;
    const rawRow = decompressed.subarray(srcPos, srcPos + stride);
    srcPos += stride;

    // Apply PNG filter to reconstruct scanline
    switch (filterType) {
      case 0: // None
        currRow.set(rawRow);
        break;
      case 1: // Sub — difference from left pixel
        for (let x = 0; x < stride; x++) {
          currRow[x] = ((rawRow[x] ?? 0) + (x >= bpp ? (currRow[x - bpp] ?? 0) : 0)) & 0xff;
        }
        break;
      case 2: // Up — difference from above pixel
        for (let x = 0; x < stride; x++) {
          currRow[x] = ((rawRow[x] ?? 0) + (prevRow[x] ?? 0)) & 0xff;
        }
        break;
      case 3: // Average — difference from floor((left + above) / 2)
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
          const up = prevRow[x] ?? 0;
          currRow[x] = ((rawRow[x] ?? 0) + Math.floor((left + up) / 2)) & 0xff;
        }
        break;
      case 4: // Paeth predictor
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
          const up = prevRow[x] ?? 0;
          const upLeft = x >= bpp ? (prevRow[x - bpp] ?? 0) : 0;
          currRow[x] = ((rawRow[x] ?? 0) + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`decodePng: unknown filter type ${filterType} at row ${y}`);
    }

    // Write to output as RGBA (expand RGB→RGBA if colorType=2)
    const dstBase = y * width * 4;
    if (colorType === 6) {
      output.set(currRow, dstBase);
    } else {
      // RGB → RGBA: set alpha to 255
      for (let x = 0; x < width; x++) {
        output[dstBase + x * 4 + 0] = currRow[x * 3 + 0] ?? 0;
        output[dstBase + x * 4 + 1] = currRow[x * 3 + 1] ?? 0;
        output[dstBase + x * 4 + 2] = currRow[x * 3 + 2] ?? 0;
        output[dstBase + x * 4 + 3] = 255;
      }
    }

    prevRow.set(currRow);
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
 * Supports colorType 2 (RGB) at 16-bit depth, non-interlaced.
 */
export function decodePngToRgb48le(buf: Buffer): { width: number; height: number; data: Buffer } {
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
    throw new Error("decodePngToRgb48le: not a PNG file");
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

    pos += 12 + chunkLen;
  }

  if (bitDepth !== 16) {
    throw new Error(`decodePngToRgb48le: unsupported bit depth ${bitDepth} (expected 16)`);
  }
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(
      `decodePngToRgb48le: unsupported color type ${colorType} (expected 2=RGB or 6=RGBA)`,
    );
  }

  // 16-bit: 2 bytes per channel. RGB=6 bytes/pixel, RGBA=8 bytes/pixel
  const bpp = colorType === 6 ? 8 : 6;
  const stride = width * bpp;

  const compressed = Buffer.concat(idatChunks);
  const decompressed = inflateSync(compressed);

  // Reconstruct filtered rows (filter operates on individual bytes)
  const currRow = new Uint8Array(stride);
  const prevRow = new Uint8Array(stride);

  // Output: rgb48le = 3 channels × 2 bytes (LE) = 6 bytes/pixel
  const output = Buffer.allocUnsafe(width * height * 6);

  let srcPos = 0;

  for (let y = 0; y < height; y++) {
    const filterType = decompressed[srcPos++] ?? 0;
    const rawRow = decompressed.subarray(srcPos, srcPos + stride);
    srcPos += stride;

    switch (filterType) {
      case 0:
        currRow.set(rawRow);
        break;
      case 1:
        for (let x = 0; x < stride; x++) {
          currRow[x] = ((rawRow[x] ?? 0) + (x >= bpp ? (currRow[x - bpp] ?? 0) : 0)) & 0xff;
        }
        break;
      case 2:
        for (let x = 0; x < stride; x++) {
          currRow[x] = ((rawRow[x] ?? 0) + (prevRow[x] ?? 0)) & 0xff;
        }
        break;
      case 3:
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
          const up = prevRow[x] ?? 0;
          currRow[x] = ((rawRow[x] ?? 0) + Math.floor((left + up) / 2)) & 0xff;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
          const up = prevRow[x] ?? 0;
          const upLeft = x >= bpp ? (prevRow[x - bpp] ?? 0) : 0;
          currRow[x] = ((rawRow[x] ?? 0) + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`decodePngToRgb48le: unknown filter type ${filterType} at row ${y}`);
    }

    // Convert big-endian 16-bit RGB(A) → little-endian rgb48le (drop alpha if RGBA)
    const dstBase = y * width * 6;
    for (let x = 0; x < width; x++) {
      const srcBase = x * bpp;
      // PNG stores 16-bit as big-endian: [high, low]. Swap to little-endian: [low, high].
      output[dstBase + x * 6 + 0] = currRow[srcBase + 1] ?? 0; // R low
      output[dstBase + x * 6 + 1] = currRow[srcBase + 0] ?? 0; // R high
      output[dstBase + x * 6 + 2] = currRow[srcBase + 3] ?? 0; // G low
      output[dstBase + x * 6 + 3] = currRow[srcBase + 2] ?? 0; // G high
      output[dstBase + x * 6 + 4] = currRow[srcBase + 5] ?? 0; // B low
      output[dstBase + x * 6 + 5] = currRow[srcBase + 4] ?? 0; // B high
    }

    prevRow.set(currRow);
  }

  return { width, height, data: output };
}

// ── sRGB → HLG color conversion ───────────────────────────────────────────────

/**
 * 256-entry LUT: sRGB 8-bit value → HLG 16-bit signal value.
 *
 * Converts DOM overlay pixels (Chrome sRGB) to HLG signal space so they
 * composite correctly into the HLG/BT.2020 output without color shift.
 *
 * Pipeline per channel: sRGB EOTF (decode gamma) → linear → HLG OETF → 16-bit.
 *
 * Note: this converts the transfer function (gamma) but not the color primaries
 * (bt709 → bt2020). For neutral/near-neutral content (text, UI elements) the
 * gamut difference is negligible. Saturated sRGB colors may shift slightly.
 */
function buildSrgbToHlgLut(): Uint16Array {
  const lut = new Uint16Array(256);

  // HLG OETF constants (Rec. 2100)
  const a = 0.17883277;
  const b = 1 - 4 * a;
  const c = 0.5 - a * Math.log(4 * a);

  for (let i = 0; i < 256; i++) {
    // sRGB EOTF: signal → linear
    const v = i / 255;
    const linear = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

    // HLG OETF: linear → HLG signal
    const hlg = linear <= 1 / 12 ? Math.sqrt(3 * linear) : a * Math.log(12 * linear - b) + c;

    lut[i] = Math.min(65535, Math.round(hlg * 65535));
  }

  return lut;
}

const SRGB_TO_HLG = buildSrgbToHlgLut();

// ── Alpha compositing ─────────────────────────────────────────────────────────

/**
 * Alpha-composite a DOM RGBA overlay (8-bit sRGB) onto an HDR frame
 * (rgb48le, HLG-encoded) in memory.
 *
 * DOM pixels are converted from sRGB to HLG signal space before blending
 * so the composited output is uniformly HLG-encoded. Without this conversion,
 * sRGB content (text, SDR video rendered by Chrome) would have incorrect
 * gamma and appear orange/washed in HDR playback.
 *
 * For each pixel:
 *   - If DOM alpha == 0 → copy HDR pixel unchanged
 *   - If DOM alpha == 255 → use DOM pixel (sRGB→HLG converted)
 *   - Otherwise → blend converted DOM with HDR in HLG signal domain
 *
 * @param domRgba  Raw RGBA pixel data from decodePng() — width*height*4 bytes
 * @param hdrRgb48 HDR frame in rgb48le format — width*height*6 bytes
 * @returns New rgb48le buffer with DOM composited on top (HLG-encoded)
 */
export function blitRgba8OverRgb48le(
  domRgba: Uint8Array,
  hdrRgb48: Buffer,
  width: number,
  height: number,
): Buffer {
  const pixelCount = width * height;
  const out = Buffer.allocUnsafe(pixelCount * 6);
  const lut = SRGB_TO_HLG;

  for (let i = 0; i < pixelCount; i++) {
    const da = domRgba[i * 4 + 3] ?? 0;

    if (da === 0) {
      // Fully transparent DOM pixel — copy HDR unchanged
      out[i * 6 + 0] = hdrRgb48[i * 6 + 0] ?? 0;
      out[i * 6 + 1] = hdrRgb48[i * 6 + 1] ?? 0;
      out[i * 6 + 2] = hdrRgb48[i * 6 + 2] ?? 0;
      out[i * 6 + 3] = hdrRgb48[i * 6 + 3] ?? 0;
      out[i * 6 + 4] = hdrRgb48[i * 6 + 4] ?? 0;
      out[i * 6 + 5] = hdrRgb48[i * 6 + 5] ?? 0;
    } else if (da === 255) {
      // Fully opaque DOM pixel — convert sRGB → HLG
      const r16 = lut[domRgba[i * 4 + 0] ?? 0] ?? 0;
      const g16 = lut[domRgba[i * 4 + 1] ?? 0] ?? 0;
      const b16 = lut[domRgba[i * 4 + 2] ?? 0] ?? 0;
      out.writeUInt16LE(r16, i * 6);
      out.writeUInt16LE(g16, i * 6 + 2);
      out.writeUInt16LE(b16, i * 6 + 4);
    } else {
      // Partial alpha — convert sRGB→HLG then blend in HLG signal domain
      const alpha = da / 255;
      const invAlpha = 1 - alpha;

      // Read HDR pixel (little-endian uint16, already HLG-encoded)
      const hdrR = (hdrRgb48[i * 6 + 0] ?? 0) | ((hdrRgb48[i * 6 + 1] ?? 0) << 8);
      const hdrG = (hdrRgb48[i * 6 + 2] ?? 0) | ((hdrRgb48[i * 6 + 3] ?? 0) << 8);
      const hdrB = (hdrRgb48[i * 6 + 4] ?? 0) | ((hdrRgb48[i * 6 + 5] ?? 0) << 8);

      // Convert DOM sRGB → HLG signal
      const domR = lut[domRgba[i * 4 + 0] ?? 0] ?? 0;
      const domG = lut[domRgba[i * 4 + 1] ?? 0] ?? 0;
      const domB = lut[domRgba[i * 4 + 2] ?? 0] ?? 0;

      out.writeUInt16LE(Math.round(domR * alpha + hdrR * invAlpha), i * 6);
      out.writeUInt16LE(Math.round(domG * alpha + hdrG * invAlpha), i * 6 + 2);
      out.writeUInt16LE(Math.round(domB * alpha + hdrB * invAlpha), i * 6 + 4);
    }
  }

  return out;
}
