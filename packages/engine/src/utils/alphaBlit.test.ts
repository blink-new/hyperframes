import { describe, expect, it } from "vitest";
import { deflateSync } from "zlib";
import {
  decodePng,
  blitRgba8OverRgb48le,
  blitRgb48leRegion,
  blitRgb48leAffine,
  parseTransformMatrix,
  roundedRectAlpha,
} from "./alphaBlit.js";

// ── PNG construction helpers ─────────────────────────────────────────────────

function uint32BE(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  const table = crc32Table();
  for (let i = 0; i < data.length; i++) {
    crc = (table[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let _crcTable: Uint32Array | undefined;
function crc32Table(): Uint32Array {
  if (_crcTable) return _crcTable;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  _crcTable = t;
  return t;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crcBuf = uint32BE(crc32(crcInput));
  return Buffer.concat([uint32BE(data.length), typeBuffer, data, crcBuf]);
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Build a minimal RGBA PNG for testing.
 * pixels: flat RGBA array (row-major, 8-bit per channel)
 */
function makePng(width: number, height: number, pixels: number[]): Buffer {
  // IHDR
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace none

  // Raw scanlines with filter byte 0 (None)
  const scanlines: number[] = [];
  for (let y = 0; y < height; y++) {
    scanlines.push(0); // filter type None
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      scanlines.push(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0, pixels[i + 3] ?? 0);
    }
  }

  const idatData = deflateSync(Buffer.from(scanlines));

  return Buffer.concat([
    PNG_SIG,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idatData),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── decodePng tests ──────────────────────────────────────────────────────────

describe("decodePng", () => {
  it("decodes a 1x1 RGBA PNG correctly", () => {
    // RGBA: red pixel, full opacity
    const png = makePng(1, 1, [255, 0, 0, 255]);
    const { width, height, data } = decodePng(png);
    expect(width).toBe(1);
    expect(height).toBe(1);
    expect(data[0]).toBe(255); // R
    expect(data[1]).toBe(0); // G
    expect(data[2]).toBe(0); // B
    expect(data[3]).toBe(255); // A
  });

  it("decodes a 2x2 RGBA PNG with multiple pixels", () => {
    // TL=red, TR=green, BL=blue, BR=white (all full opacity)
    const pixels = [
      255,
      0,
      0,
      255, // TL red
      0,
      255,
      0,
      255, // TR green
      0,
      0,
      255,
      255, // BL blue
      255,
      255,
      255,
      255, // BR white
    ];
    const png = makePng(2, 2, pixels);
    const { width, height, data } = decodePng(png);
    expect(width).toBe(2);
    expect(height).toBe(2);

    // Top-left: red
    expect(data[0]).toBe(255);
    expect(data[1]).toBe(0);
    expect(data[2]).toBe(0);
    expect(data[3]).toBe(255);

    // Bottom-right: white
    expect(data[12]).toBe(255);
    expect(data[13]).toBe(255);
    expect(data[14]).toBe(255);
    expect(data[15]).toBe(255);
  });

  it("decodes a transparent pixel correctly", () => {
    const png = makePng(1, 1, [128, 64, 32, 0]);
    const { data } = decodePng(png);
    expect(data[3]).toBe(0); // alpha = 0
  });

  it("decodes a semi-transparent pixel correctly", () => {
    const png = makePng(1, 1, [100, 150, 200, 128]);
    const { data } = decodePng(png);
    expect(data[0]).toBe(100);
    expect(data[1]).toBe(150);
    expect(data[2]).toBe(200);
    expect(data[3]).toBe(128);
  });

  it("throws on invalid PNG signature", () => {
    const buf = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(() => decodePng(buf)).toThrow("not a PNG file");
  });
});

// ── blitRgba8OverRgb48le tests ───────────────────────────────────────────────

/** Build an rgb48le buffer with a single solid color (16-bit per channel) */
function makeHdrFrame(
  width: number,
  height: number,
  r16: number,
  g16: number,
  b16: number,
): Buffer {
  const buf = Buffer.allocUnsafe(width * height * 6);
  for (let i = 0; i < width * height; i++) {
    buf.writeUInt16LE(r16, i * 6);
    buf.writeUInt16LE(g16, i * 6 + 2);
    buf.writeUInt16LE(b16, i * 6 + 4);
  }
  return buf;
}

/** Build a raw RGBA array (Uint8Array) with a single solid color */
function makeDomRgba(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a: number,
): Uint8Array {
  const arr = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    arr[i * 4 + 0] = r;
    arr[i * 4 + 1] = g;
    arr[i * 4 + 2] = b;
    arr[i * 4 + 3] = a;
  }
  return arr;
}

describe("blitRgba8OverRgb48le", () => {
  it("fully transparent DOM: canvas unchanged", () => {
    const canvas = makeHdrFrame(1, 1, 32000, 40000, 50000);
    const dom = makeDomRgba(1, 1, 255, 0, 0, 0); // red but alpha=0
    blitRgba8OverRgb48le(dom, canvas, 1, 1);

    expect(canvas.readUInt16LE(0)).toBe(32000);
    expect(canvas.readUInt16LE(2)).toBe(40000);
    expect(canvas.readUInt16LE(4)).toBe(50000);
  });

  it("fully opaque DOM: sRGB→HLG converted values overwrite canvas", () => {
    const canvas = makeHdrFrame(1, 1, 10000, 20000, 30000);
    const dom = makeDomRgba(1, 1, 255, 128, 0, 255); // R=255, G=128, B=0, full opaque
    blitRgba8OverRgb48le(dom, canvas, 1, 1);

    // sRGB 255 → HLG 65535 (white maps to white)
    // sRGB 128 → HLG ~46484 (mid-gray maps higher due to HLG OETF)
    // sRGB 0 → HLG 0
    expect(canvas.readUInt16LE(0)).toBe(65535);
    expect(canvas.readUInt16LE(2)).toBeGreaterThan(40000); // HLG mid-gray > sRGB mid-gray
    expect(canvas.readUInt16LE(2)).toBeLessThan(50000);
    expect(canvas.readUInt16LE(4)).toBe(0);
  });

  it("sRGB→HLG: black stays black, white stays white", () => {
    const canvasBlack = makeHdrFrame(1, 1, 0, 0, 0);
    const domBlack = makeDomRgba(1, 1, 0, 0, 0, 255);
    blitRgba8OverRgb48le(domBlack, canvasBlack, 1, 1);
    expect(canvasBlack.readUInt16LE(0)).toBe(0);

    const canvasWhite = makeHdrFrame(1, 1, 0, 0, 0);
    const domWhite = makeDomRgba(1, 1, 255, 255, 255, 255);
    blitRgba8OverRgb48le(domWhite, canvasWhite, 1, 1);
    expect(canvasWhite.readUInt16LE(0)).toBe(65535);
  });

  it("50% alpha: HLG-converted DOM blended with canvas", () => {
    // DOM: white (255, 255, 255) at alpha=128 (~50%)
    // Canvas: black (0, 0, 0)
    const canvas = makeHdrFrame(1, 1, 0, 0, 0);
    const dom = makeDomRgba(1, 1, 255, 255, 255, 128);
    blitRgba8OverRgb48le(dom, canvas, 1, 1);

    // sRGB 255 → HLG 65535, blended 50/50 with black
    const alpha = 128 / 255;
    const expectedR = Math.round(65535 * alpha);
    expect(canvas.readUInt16LE(0)).toBeCloseTo(expectedR, -1);
  });

  it("50% alpha blends with non-zero canvas", () => {
    // DOM: 8-bit red=200, canvas: 16-bit red=32000, alpha=128
    const canvas = makeHdrFrame(1, 1, 32000, 0, 0);
    const dom = makeDomRgba(1, 1, 200, 0, 0, 128);
    blitRgba8OverRgb48le(dom, canvas, 1, 1);

    // sRGB 200 → HLG value, blended ~50/50 with canvas red=32000
    // Result should be higher than 32000 (pulled up by the HLG-converted DOM value)
    expect(canvas.readUInt16LE(0)).toBeGreaterThan(32000);
  });

  it("handles a 2x2 frame correctly pixel-by-pixel", () => {
    const canvas = makeHdrFrame(2, 2, 0, 0, 0);
    // First pixel: fully opaque white. Others: fully transparent.
    const dom = new Uint8Array(2 * 2 * 4);
    dom[0] = 255;
    dom[1] = 255;
    dom[2] = 255;
    dom[3] = 255; // pixel 0: opaque white
    // pixels 1-3: alpha=0 (transparent)

    blitRgba8OverRgb48le(dom, canvas, 2, 2);

    // Pixel 0: sRGB white → HLG white (65535)
    expect(canvas.readUInt16LE(0)).toBe(65535);
    expect(canvas.readUInt16LE(2)).toBe(65535);
    expect(canvas.readUInt16LE(4)).toBe(65535);

    // Pixel 1: transparent DOM → canvas black (0, 0, 0) unchanged
    expect(canvas.readUInt16LE(6)).toBe(0);
    expect(canvas.readUInt16LE(8)).toBe(0);
    expect(canvas.readUInt16LE(10)).toBe(0);
  });
});

describe("blitRgba8OverRgb48le with PQ transfer", () => {
  it("PQ: black stays black, white maps to PQ white", () => {
    const canvasBlack = makeHdrFrame(1, 1, 0, 0, 0);
    const domBlack = makeDomRgba(1, 1, 0, 0, 0, 255);
    blitRgba8OverRgb48le(domBlack, canvasBlack, 1, 1, "pq");
    expect(canvasBlack.readUInt16LE(0)).toBe(0);

    const canvasWhite = makeHdrFrame(1, 1, 0, 0, 0);
    const domWhite = makeDomRgba(1, 1, 255, 255, 255, 255);
    blitRgba8OverRgb48le(domWhite, canvasWhite, 1, 1, "pq");
    // PQ white at SDR 203 nits is NOT 65535 (that's 10000 nits)
    // SDR white in PQ ≈ 58% signal → ~38000
    const pqWhite = canvasWhite.readUInt16LE(0);
    expect(pqWhite).toBeGreaterThan(30000);
    expect(pqWhite).toBeLessThan(45000);
  });

  it("PQ mid-gray differs from HLG mid-gray", () => {
    const canvasHlg = makeHdrFrame(1, 1, 0, 0, 0);
    const canvasPq = makeHdrFrame(1, 1, 0, 0, 0);
    const dom = makeDomRgba(1, 1, 128, 128, 128, 255);

    blitRgba8OverRgb48le(dom, canvasHlg, 1, 1, "hlg");
    blitRgba8OverRgb48le(dom, canvasPq, 1, 1, "pq");

    const hlgVal = canvasHlg.readUInt16LE(0);
    const pqVal = canvasPq.readUInt16LE(0);
    // PQ and HLG encode mid-gray differently
    expect(hlgVal).not.toBe(pqVal);
    // Both should be non-zero
    expect(hlgVal).toBeGreaterThan(0);
    expect(pqVal).toBeGreaterThan(0);
  });
});

// ── blitRgb48leRegion tests ──────────────────────────────────────────────────

describe("blitRgb48leRegion", () => {
  it("copies a region at position (0,0) — full overlap", () => {
    const canvas = Buffer.alloc(4 * 4 * 6); // 4x4 black
    const source = makeHdrFrame(2, 2, 10000, 20000, 30000);
    blitRgb48leRegion(canvas, source, 0, 0, 2, 2, 4);
    expect(canvas.readUInt16LE(0)).toBe(10000);
    expect(canvas.readUInt16LE(2)).toBe(20000);
    expect(canvas.readUInt16LE(4)).toBe(30000);
    expect(canvas.readUInt16LE(2 * 6)).toBe(0);
  });

  it("copies a region at offset position", () => {
    const canvas = Buffer.alloc(4 * 4 * 6);
    const source = makeHdrFrame(2, 2, 50000, 40000, 30000);
    blitRgb48leRegion(canvas, source, 1, 1, 2, 2, 4);
    expect(canvas.readUInt16LE(0)).toBe(0);
    const off = (1 * 4 + 1) * 6;
    expect(canvas.readUInt16LE(off)).toBe(50000);
  });

  it("clips when region extends beyond canvas edge", () => {
    const canvas = Buffer.alloc(4 * 4 * 6);
    const source = makeHdrFrame(3, 3, 10000, 20000, 30000);
    blitRgb48leRegion(canvas, source, 2, 2, 3, 3, 4);
    const off = (2 * 4 + 2) * 6;
    expect(canvas.readUInt16LE(off)).toBe(10000);
    const off2 = (3 * 4 + 3) * 6;
    expect(canvas.readUInt16LE(off2)).toBe(10000);
    expect(canvas.length).toBe(4 * 4 * 6);
  });

  it("applies opacity when provided", () => {
    const canvas = Buffer.alloc(1 * 1 * 6);
    const source = makeHdrFrame(1, 1, 40000, 40000, 40000);
    blitRgb48leRegion(canvas, source, 0, 0, 1, 1, 1, 0.5);
    expect(canvas.readUInt16LE(0)).toBe(20000);
  });

  it("no-op for zero-size region", () => {
    const canvas = Buffer.alloc(4 * 4 * 6);
    const source = makeHdrFrame(2, 2, 10000, 20000, 30000);
    blitRgb48leRegion(canvas, source, 0, 0, 0, 0, 4);
    expect(canvas.readUInt16LE(0)).toBe(0);
  });
});

// ── parseTransformMatrix tests ───────────────────────────────────────────────

describe("parseTransformMatrix", () => {
  it("returns null for 'none'", () => {
    expect(parseTransformMatrix("none")).toBeNull();
  });

  it("parses identity matrix", () => {
    const m = parseTransformMatrix("matrix(1, 0, 0, 1, 0, 0)");
    expect(m).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("parses scale + translate", () => {
    const m = parseTransformMatrix("matrix(0.85, 0, 0, 0.85, 100, 50)");
    expect(m).toEqual([0.85, 0, 0, 0.85, 100, 50]);
  });

  it("parses rotation (45 degrees)", () => {
    const cos = Math.cos(Math.PI / 4);
    const sin = Math.sin(Math.PI / 4);
    const m = parseTransformMatrix(`matrix(${cos}, ${sin}, ${-sin}, ${cos}, 0, 0)`);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m[0]).toBeCloseTo(cos, 10);
    expect(m[1]).toBeCloseTo(sin, 10);
  });

  it("parses negative values", () => {
    const m = parseTransformMatrix("matrix(-1, 0, 0, -1, -50, -100)");
    expect(m).toEqual([-1, 0, 0, -1, -50, -100]);
  });

  it("returns null for empty string", () => {
    expect(parseTransformMatrix("")).toBeNull();
  });

  it("returns null for unsupported 3d matrix", () => {
    expect(parseTransformMatrix("matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)")).toBeNull();
  });
});

// ── blitRgb48leAffine tests ─────────────────────────────────────────────────

describe("blitRgb48leAffine", () => {
  it("identity matrix produces same result as blitRgb48leRegion", () => {
    const canvas1 = Buffer.alloc(4 * 4 * 6);
    const canvas2 = Buffer.alloc(4 * 4 * 6);
    const source = makeHdrFrame(2, 2, 10000, 20000, 30000);
    const identity = [1, 0, 0, 1, 0, 0];

    blitRgb48leRegion(canvas1, source, 0, 0, 2, 2, 4);
    blitRgb48leAffine(canvas2, source, identity, 2, 2, 4, 4);

    expect(Buffer.compare(canvas1, canvas2)).toBe(0);
  });

  it("translation moves pixels", () => {
    const canvas = Buffer.alloc(4 * 4 * 6);
    const source = makeHdrFrame(1, 1, 50000, 40000, 30000);
    const translate = [1, 0, 0, 1, 2, 1];
    blitRgb48leAffine(canvas, source, translate, 1, 1, 4, 4);

    expect(canvas.readUInt16LE(0)).toBe(0);
    const off = (1 * 4 + 2) * 6;
    expect(canvas.readUInt16LE(off)).toBe(50000);
  });

  it("scale down by 0.5 shrinks the output", () => {
    const canvas = Buffer.alloc(4 * 4 * 6);
    const source = makeHdrFrame(4, 4, 40000, 30000, 20000);
    const scale = [0.5, 0, 0, 0.5, 0, 0];
    blitRgb48leAffine(canvas, source, scale, 4, 4, 4, 4);

    expect(canvas.readUInt16LE(0)).toBeGreaterThan(0);
    expect(canvas.readUInt16LE((1 * 4 + 1) * 6)).toBeGreaterThan(0);
    expect(canvas.readUInt16LE(2 * 6)).toBe(0);
  });

  it("scale up by 2 enlarges the output", () => {
    const canvas = Buffer.alloc(4 * 4 * 6);
    const source = makeHdrFrame(2, 2, 40000, 30000, 20000);
    const scale = [2, 0, 0, 2, 0, 0];
    blitRgb48leAffine(canvas, source, scale, 2, 2, 4, 4);

    for (let i = 0; i < 16; i++) {
      expect(canvas.readUInt16LE(i * 6)).toBeGreaterThan(0);
    }
  });

  it("opacity blends with canvas", () => {
    const canvas = makeHdrFrame(1, 1, 20000, 20000, 20000);
    const source = makeHdrFrame(1, 1, 60000, 60000, 60000);
    const identity = [1, 0, 0, 1, 0, 0];
    blitRgb48leAffine(canvas, source, identity, 1, 1, 1, 1, 0.5);

    expect(canvas.readUInt16LE(0)).toBe(40000);
  });

  it("out-of-bounds source coordinates are clipped", () => {
    const canvas = Buffer.alloc(2 * 2 * 6);
    const source = makeHdrFrame(1, 1, 50000, 40000, 30000);
    const translate = [1, 0, 0, 1, 10, 10];
    blitRgb48leAffine(canvas, source, translate, 1, 1, 2, 2);

    expect(canvas.readUInt16LE(0)).toBe(0);
    expect(canvas.readUInt16LE(6)).toBe(0);
  });
});

// ── Round-trip test: decodePng → blitRgba8OverRgb48le ────────────────────────

describe("decodePng + blitRgba8OverRgb48le integration", () => {
  it("transparent PNG overlay leaves canvas untouched", () => {
    const width = 2;
    const height = 2;

    // Build a fully transparent PNG
    const pixels = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // all alpha=0
    const png = makePng(width, height, pixels);
    const { data: domRgba } = decodePng(png);

    // Canvas pre-filled with known HDR values
    const canvas = makeHdrFrame(width, height, 10000, 20000, 30000);
    blitRgba8OverRgb48le(domRgba, canvas, width, height);

    // All pixels should be unchanged
    for (let i = 0; i < width * height; i++) {
      expect(canvas.readUInt16LE(i * 6 + 0)).toBe(10000);
      expect(canvas.readUInt16LE(i * 6 + 2)).toBe(20000);
      expect(canvas.readUInt16LE(i * 6 + 4)).toBe(30000);
    }
  });

  it("fully opaque PNG overlay overwrites all canvas pixels (sRGB→HLG)", () => {
    const width = 2;
    const height = 2;

    // Build a fully opaque blue PNG (sRGB blue = 0,0,255)
    const pixels = Array(width * height)
      .fill(null)
      .flatMap(() => [0, 0, 255, 255]);
    const png = makePng(width, height, pixels);
    const { data: domRgba } = decodePng(png);

    const canvas = makeHdrFrame(width, height, 50000, 40000, 30000);
    blitRgba8OverRgb48le(domRgba, canvas, width, height);

    // sRGB blue (0,0,255) → HLG (0, 0, 65535) — black/white map identically
    for (let i = 0; i < width * height; i++) {
      expect(canvas.readUInt16LE(i * 6 + 0)).toBe(0);
      expect(canvas.readUInt16LE(i * 6 + 2)).toBe(0);
      expect(canvas.readUInt16LE(i * 6 + 4)).toBe(65535);
    }
  });
});

// ── roundedRectAlpha tests ──────────────────────────────────────────────────

describe("roundedRectAlpha", () => {
  const uniform20: [number, number, number, number] = [20, 20, 20, 20];

  it("returns 1 for center pixel", () => {
    expect(roundedRectAlpha(50, 50, 100, 100, uniform20)).toBe(1);
  });

  it("returns 1 for pixel well inside edge (not in corner zone)", () => {
    // On top edge but past the corner zone (x >= radius)
    expect(roundedRectAlpha(50, 5, 100, 100, uniform20)).toBe(1);
  });

  it("returns 0 for pixel at the extreme corner (outside rounded area)", () => {
    // Top-left corner: (0, 0) is far from circle center at (20, 20)
    // dist = sqrt(400 + 400) = 28.28, well beyond radius 20
    expect(roundedRectAlpha(0, 0, 100, 100, uniform20)).toBe(0);
  });

  it("returns 1 for pixel well inside corner circle", () => {
    // Pixel at (15, 15): dist from center (20, 20) = sqrt(25+25) = 7.07 << 20
    expect(roundedRectAlpha(15, 15, 100, 100, uniform20)).toBe(1);
  });

  it("returns fractional alpha at corner edge (anti-aliasing)", () => {
    // Find a point near the circle edge. radius = 20, center at (20, 20).
    // Point on the circle: (20 - 20*cos(45°), 20 - 20*sin(45°)) ≈ (5.86, 5.86)
    // Shift slightly inward for fractional alpha
    const edgePx = 20 - 20 * Math.cos(Math.PI / 4); // ~5.86
    const alpha = roundedRectAlpha(edgePx, edgePx, 100, 100, uniform20);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
  });

  it("handles all four corners symmetrically", () => {
    // Test top-right corner (x near w, y near 0)
    expect(roundedRectAlpha(100, 0, 100, 100, uniform20)).toBe(0);
    // Test bottom-right corner
    expect(roundedRectAlpha(100, 100, 100, 100, uniform20)).toBe(0);
    // Test bottom-left corner
    expect(roundedRectAlpha(0, 100, 100, 100, uniform20)).toBe(0);
  });

  it("returns 1 everywhere for zero radii", () => {
    const zero: [number, number, number, number] = [0, 0, 0, 0];
    expect(roundedRectAlpha(0, 0, 100, 100, zero)).toBe(1);
    expect(roundedRectAlpha(99, 0, 100, 100, zero)).toBe(1);
    expect(roundedRectAlpha(0, 99, 100, 100, zero)).toBe(1);
    expect(roundedRectAlpha(99, 99, 100, 100, zero)).toBe(1);
  });

  it("supports per-corner radii", () => {
    const mixed: [number, number, number, number] = [20, 0, 10, 0];
    // Top-left has radius 20 — corner pixel outside
    expect(roundedRectAlpha(0, 0, 100, 100, mixed)).toBe(0);
    // Top-right has radius 0 — corner pixel inside
    expect(roundedRectAlpha(99, 0, 100, 100, mixed)).toBe(1);
    // Bottom-right has radius 10 — extreme corner outside
    expect(roundedRectAlpha(100, 100, 100, 100, mixed)).toBe(0);
    // Bottom-left has radius 0 — corner pixel inside
    expect(roundedRectAlpha(0, 99, 100, 100, mixed)).toBe(1);
  });
});

// ── blitRgb48leRegion with borderRadius ─────────────────────────────────────

describe("blitRgb48leRegion with borderRadius", () => {
  it("clips corner pixels when borderRadius is set", () => {
    // 10x10 source placed at origin on a 10x10 canvas, radius 5
    const canvas = Buffer.alloc(10 * 10 * 6);
    const source = makeHdrFrame(10, 10, 40000, 30000, 20000);
    const br: [number, number, number, number] = [5, 5, 5, 5];
    blitRgb48leRegion(canvas, source, 0, 0, 10, 10, 10, undefined, br);

    // Center pixel should be written
    const centerOff = (5 * 10 + 5) * 6;
    expect(canvas.readUInt16LE(centerOff)).toBe(40000);

    // Corner pixel (0,0) should be clipped (remain 0)
    expect(canvas.readUInt16LE(0)).toBe(0);
  });

  it("no effect when borderRadius is all zeros", () => {
    const canvas1 = Buffer.alloc(4 * 4 * 6);
    const canvas2 = Buffer.alloc(4 * 4 * 6);
    const source = makeHdrFrame(4, 4, 40000, 30000, 20000);

    blitRgb48leRegion(canvas1, source, 0, 0, 4, 4, 4);
    blitRgb48leRegion(canvas2, source, 0, 0, 4, 4, 4, undefined, [0, 0, 0, 0]);

    expect(Buffer.compare(canvas1, canvas2)).toBe(0);
  });

  it("combines opacity and borderRadius", () => {
    // Canvas with known background, source with known values
    const canvas = makeHdrFrame(10, 10, 20000, 20000, 20000);
    const source = makeHdrFrame(10, 10, 60000, 60000, 60000);
    const br: [number, number, number, number] = [3, 3, 3, 3];

    blitRgb48leRegion(canvas, source, 0, 0, 10, 10, 10, 0.5, br);

    // Center pixel: opacity 0.5, mask 1.0 → effective 0.5
    // Result: 60000 * 0.5 + 20000 * 0.5 = 40000
    const centerOff = (5 * 10 + 5) * 6;
    expect(canvas.readUInt16LE(centerOff)).toBe(40000);

    // Corner pixel (0,0): mask 0.0 → skipped, canvas unchanged
    expect(canvas.readUInt16LE(0)).toBe(20000);
  });
});

// ── blitRgb48leAffine with borderRadius ─────────────────────────────────────

describe("blitRgb48leAffine with borderRadius", () => {
  it("clips corner pixels with identity transform", () => {
    const canvas = Buffer.alloc(10 * 10 * 6);
    const source = makeHdrFrame(10, 10, 40000, 30000, 20000);
    const identity = [1, 0, 0, 1, 0, 0];
    const br: [number, number, number, number] = [5, 5, 5, 5];

    blitRgb48leAffine(canvas, source, identity, 10, 10, 10, 10, undefined, br);

    // Center pixel should be written
    const centerOff = (5 * 10 + 5) * 6;
    expect(canvas.readUInt16LE(centerOff)).toBe(40000);

    // Corner pixel (0,0) should be clipped
    expect(canvas.readUInt16LE(0)).toBe(0);
  });

  it("mask follows transform (scaled output has rounded corners)", () => {
    // 4x4 source scaled up 2× on an 8×8 canvas, radius 2 in source space
    const canvas = Buffer.alloc(8 * 8 * 6);
    const source = makeHdrFrame(4, 4, 50000, 40000, 30000);
    const scale2x = [2, 0, 0, 2, 0, 0];
    const br: [number, number, number, number] = [2, 2, 2, 2];

    blitRgb48leAffine(canvas, source, scale2x, 4, 4, 8, 8, undefined, br);

    // Canvas center (4,4) maps to source (2,2) — inside, should be written
    const centerOff = (4 * 8 + 4) * 6;
    expect(canvas.readUInt16LE(centerOff)).toBeGreaterThan(0);

    // Canvas corner (0,0) maps to source (0,0) — outside radius, should be clipped
    expect(canvas.readUInt16LE(0)).toBe(0);
  });

  it("no effect when borderRadius is undefined", () => {
    const canvas1 = Buffer.alloc(4 * 4 * 6);
    const canvas2 = Buffer.alloc(4 * 4 * 6);
    const source = makeHdrFrame(4, 4, 40000, 30000, 20000);
    const identity = [1, 0, 0, 1, 0, 0];

    blitRgb48leAffine(canvas1, source, identity, 4, 4, 4, 4);
    blitRgb48leAffine(canvas2, source, identity, 4, 4, 4, 4, undefined, undefined);

    expect(Buffer.compare(canvas1, canvas2)).toBe(0);
  });
});
