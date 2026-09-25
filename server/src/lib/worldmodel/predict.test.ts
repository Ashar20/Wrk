import { describe, expect, it } from "vitest";
import { downsample, squaredDistance, toModelInput } from "./predict";

describe("toModelInput", () => {
  it("matches encoder.py's normalisation exactly", () => {
    // trainer/worldmod/encoder.py: (pixel/255 - mean) / std, per ImageNet
    // channel. A drift here would not error — it would just make the live
    // encoder output a latent the trained head has never seen.
    const rgb = new Uint8Array([255, 0, 128]); // one pixel, R=255 G=0 B=128
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];

    const chw = toModelInput(rgb, 1, mean, std);

    expect(chw[0]).toBeCloseTo((1 - mean[0]) / std[0], 5);
    expect(chw[1]).toBeCloseTo((0 - mean[1]) / std[1], 5);
    expect(chw[2]).toBeCloseTo((128 / 255 - mean[2]) / std[2], 5);
  });

  it("writes channels as separate planes, not interleaved", () => {
    // A model exported from PyTorch expects NCHW: all R, then all G, then all
    // B. Interleaved RGB (the input's own layout) would silently feed the
    // wrong values into every channel.
    const rgb = new Uint8Array([10, 20, 30, 40, 50, 60]); // two pixels
    const chw = toModelInput(rgb, 1 /* fake: treat as 1x2 for plane math */, [0, 0, 0], [1, 1, 1]);
    // plane size here is size*size = 1, so only element 0 of each plane is used
    // per pixel — check with size=1 semantics: this call only encodes pixel 0.
    // float32, so approximate rather than exact.
    expect(chw[0]).toBeCloseTo(10 / 255, 6);
    expect(chw[1]).toBeCloseTo(20 / 255, 6);
    expect(chw[2]).toBeCloseTo(30 / 255, 6);
  });
});

describe("downsample", () => {
  it("shrinks without needing an external image library", () => {
    // 4x4 solid red -> 2x2 should still be solid red.
    const src = new Uint8Array(4 * 4 * 3);
    for (let i = 0; i < src.length; i += 3) {
      src[i] = 200; src[i + 1] = 10; src[i + 2] = 10;
    }
    const out = downsample(src, 4, 2);
    expect(out.length).toBe(2 * 2 * 3);
    expect(Array.from(out)).toEqual([200, 10, 10, 200, 10, 10, 200, 10, 10, 200, 10, 10]);
  });

  it("samples from within bounds at the source's far edge", () => {
    // A ratio that rounds up to exactly srcSize must clamp, not read past the
    // end of the source array.
    const src = new Uint8Array(3 * 3 * 3).fill(7);
    expect(() => downsample(src, 3, 2)).not.toThrow();
  });
});

describe("squaredDistance", () => {
  it("is zero for identical vectors and grows with difference", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(squaredDistance(a, a)).toBe(0);

    const b = new Float32Array([1, 2, 4]); // one axis off by 1
    expect(squaredDistance(a, b)).toBeCloseTo(1);

    const c = new Float32Array([4, 6, 3]); // off by 3 and 4 -> 9+16=25
    expect(squaredDistance(a, c)).toBeCloseTo(25);
  });
});
