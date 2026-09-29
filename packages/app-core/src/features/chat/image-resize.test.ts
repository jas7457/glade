import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IMAGE_LIMITS, type ImageLimits } from "@glade/protocol";
import { fitWithin, planImageEncodes, prepareImage } from "./image-resize";

const MB = 1024 * 1024;
const limits: ImageLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * MB, jpegQuality: 80 };

describe("fitWithin", () => {
  it("scales down keeping the aspect ratio, never up", () => {
    expect(fitWithin(6000, 4000, 2000, 2000)).toEqual({ width: 2000, height: 1333 });
    expect(fitWithin(3000, 4000, 2000, 2000)).toEqual({ width: 1500, height: 2000 });
    expect(fitWithin(4000, 1000, 2000, 1800)).toEqual({ width: 2000, height: 500 });
    expect(fitWithin(800, 600, 2000, 2000)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(100000, 1, 2000, 2000)).toEqual({ width: 2000, height: 1 });
  });
});

describe("planImageEncodes", () => {
  it("sends small images in supported formats unchanged", () => {
    expect(planImageEncodes({ width: 1200, height: 800, mimeType: "image/jpeg", bytes: MB }, limits)).toEqual([]);
    expect(planImageEncodes({ width: 2000, height: 2000, mimeType: "image/png", bytes: 4.5 * MB }, limits)).toEqual([]);
  });

  it("re-encodes a big phone photo as JPEG at the model quality, then lower quality, then smaller", () => {
    const plan = planImageEncodes({ width: 6000, height: 4000, mimeType: "image/jpeg", bytes: 11 * MB }, limits);
    expect(plan[0]).toEqual({ width: 2000, height: 1333, mimeType: "image/jpeg", quality: 0.8 });
    expect(plan.every((a) => a.mimeType === "image/jpeg")).toBe(true);
    // quality steps at full size
    const full = plan.filter((a) => a.width === 2000);
    expect(full.map((a) => a.quality)).toEqual([0.8, 0.65, 0.5, 0.4]);
    // then dimensions shrink, monotonically, keeping the aspect ratio
    const smaller = plan.filter((a) => a.width < 2000);
    expect(smaller.length).toBeGreaterThan(3);
    smaller.forEach((a, i) => {
      if (i > 0) expect(a.width).toBeLessThan(smaller[i - 1]!.width);
      expect(a.width / a.height).toBeCloseTo(1.5, 1);
      expect(a.quality).toBe(0.65);
    });
    expect(Math.min(...plan.map((a) => a.height))).toBeGreaterThanOrEqual(64);
  });

  it("tries PNG first for PNG sources (screenshots, transparency)", () => {
    const plan = planImageEncodes({ width: 3000, height: 2000, mimeType: "image/png", bytes: 3 * MB }, limits);
    expect(plan[0]).toEqual({ width: 2000, height: 1333, mimeType: "image/png" });
    expect(plan[1]).toMatchObject({ mimeType: "image/jpeg", quality: 0.8 });
  });

  it("re-encodes when only the byte size is over, or the format isn't widely supported", () => {
    expect(planImageEncodes({ width: 1000, height: 1000, mimeType: "image/jpeg", bytes: 6 * MB }, limits)[0]).toEqual({
      width: 1000, height: 1000, mimeType: "image/jpeg", quality: 0.8,
    });
    expect(planImageEncodes({ width: 500, height: 500, mimeType: "image/bmp", bytes: MB }, limits)[0]).toMatchObject({ mimeType: "image/jpeg" });
  });

  it("uses the default limits and clamps odd quality values", () => {
    expect(planImageEncodes({ width: 4000, height: 4000, mimeType: "image/jpeg", bytes: MB })[0]).toMatchObject({
      width: DEFAULT_IMAGE_LIMITS.maxWidth,
      quality: DEFAULT_IMAGE_LIMITS.jpegQuality / 100,
    });
    expect(planImageEncodes({ width: 4000, height: 10, mimeType: "image/jpeg", bytes: MB }, { ...limits, jpegQuality: 20 })[0]).toMatchObject({ quality: 0.4 });
  });
});

describe("prepareImage (canvas mocked)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockCanvas(sizeFor: (type: string, quality: number | undefined, width: number) => number) {
    const drawn: Array<{ type: string; quality?: number; width: number; height: number }> = [];
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag !== "canvas") return createElement(tag);
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ fillRect() {}, drawImage() {}, fillStyle: "", imageSmoothingEnabled: false, imageSmoothingQuality: "low" }),
        toBlob(cb: (b: Blob | null) => void, type: string, quality?: number) {
          drawn.push({ type, quality, width: canvas.width, height: canvas.height });
          cb(new Blob([new Uint8Array(sizeFor(type, quality, canvas.width))], { type }));
        },
      };
      return canvas as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);
    return drawn;
  }

  function stubBitmap(width: number, height: number) {
    const close = vi.fn();
    const create = vi.fn(async () => ({ width, height, close }));
    vi.stubGlobal("createImageBitmap", create);
    return { create, close };
  }

  it("decodes with EXIF orientation and returns the first encode that fits", async () => {
    const { create, close } = stubBitmap(6000, 4000);
    const drawn = mockCanvas((_type, quality) => (quality === 0.8 ? 6 * MB : 3 * MB));
    const file = new File([new Uint8Array(100)], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: 11 * MB });

    const out = await prepareImage(file, limits);
    expect(create).toHaveBeenCalledWith(file, { imageOrientation: "from-image" });
    expect(drawn.map((d) => d.quality)).toEqual([0.8, 0.65]);
    expect(out).toMatchObject({ mimeType: "image/jpeg", width: 2000, height: 1333, bytes: 3 * MB });
    expect(atob(out.data).length).toBe(3 * MB);
    expect(close).toHaveBeenCalled();
  });

  it("returns the original bytes when nothing needs to change", async () => {
    stubBitmap(100, 100);
    const drawn = mockCanvas(() => 1);
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    const out = await prepareImage(file, limits);
    expect(drawn).toEqual([]);
    expect(out).toMatchObject({ mimeType: "image/png", data: "AQID", bytes: 3 });
  });

  it("fails clearly for undecodable files or images that never fit", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new Error("bad"))));
    await expect(prepareImage(new File(["x"], "a.heic", { type: "image/heic" }), limits)).rejects.toThrow(/format isn't supported/);

    stubBitmap(4000, 4000);
    mockCanvas(() => 10 * MB);
    await expect(prepareImage(new File(["x"], "a.jpg", { type: "image/jpeg" }), limits)).rejects.toThrow(/too large/);
  });
});
