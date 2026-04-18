import { describe, expect, it } from "vitest";
import { parseVideoElements, parseImageElements, isHdrColorSpace } from "./videoFrameExtractor.js";

describe("parseVideoElements", () => {
  it("parses videos without an id or data-start attribute", () => {
    const videos = parseVideoElements('<video src="clip.mp4"></video>');

    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({
      id: "hf-video-0",
      src: "clip.mp4",
      start: 0,
      end: Infinity,
      mediaStart: 0,
      hasAudio: false,
    });
  });

  it("preserves explicit ids and derives end from data-duration", () => {
    const videos = parseVideoElements(
      '<video id="hero" src="clip.mp4" data-start="2" data-duration="5" data-media-start="1.5" data-has-audio="true"></video>',
    );

    expect(videos).toHaveLength(1);
    expect(videos[0]).toEqual({
      id: "hero",
      src: "clip.mp4",
      start: 2,
      end: 7,
      mediaStart: 1.5,
      hasAudio: true,
    });
  });
});

describe("parseImageElements", () => {
  it("parses img elements with data-start and data-duration", () => {
    const html = `<div><img id="i1" src="photo.jpg" data-start="2" data-duration="5" /></div>`;
    const images = parseImageElements(html);
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({ id: "i1", src: "photo.jpg", start: 2, end: 7 });
  });

  it("skips img without data-duration", () => {
    const html = `<div><img id="i1" src="photo.jpg" data-start="0" /></div>`;
    const images = parseImageElements(html);
    expect(images).toHaveLength(0);
  });

  it("generates stable IDs for img without id attribute", () => {
    const html = `<div><img src="a.jpg" data-start="0" data-duration="3" /><img src="b.jpg" data-start="1" data-duration="2" /></div>`;
    const images = parseImageElements(html);
    expect(images).toHaveLength(2);
    expect(images[0].id).toBe("hf-img-0");
    expect(images[1].id).toBe("hf-img-1");
  });
});

describe("isHdrColorSpace re-export", () => {
  it("delegates to utils/hdr (full suite lives in hdr.test.ts)", () => {
    expect(isHdrColorSpace(null)).toBe(false);
    expect(
      isHdrColorSpace({
        colorTransfer: "smpte2084",
        colorPrimaries: "bt2020",
        colorSpace: "bt2020nc",
      }),
    ).toBe(true);
  });
});
