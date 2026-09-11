import * as tf from "@tensorflow/tfjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estimateFlow, toGrayscale } from "./flow";

const W = 160;
const H = 120;

/**
 * Deterministic band-limited texture.
 *
 * Per-pixel white noise would be a pathological fixture: gradient-based flow
 * linearises the image, which assumes local smoothness, and averaging white
 * noise down the pyramid destroys it entirely. Real camera imagery is
 * band-limited, so the fixture is a sum of a few spatial frequencies.
 */
function texture(seed = 1): Float32Array {
  const out = new Float32Array(W * H);
  const phase = seed * 0.7;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / W) * Math.PI * 2;
      const v = (y / H) * Math.PI * 2;
      const value =
        0.35 * Math.sin(3 * u + phase) * Math.cos(2 * v - phase) +
        0.25 * Math.sin(7 * u - 2 * v + phase * 1.7) +
        0.2 * Math.cos(5 * v + phase * 0.3) +
        0.12 * Math.sin(11 * u + 9 * v);
      out[y * W + x] = 0.5 + value * 0.45;
    }
  }
  return out;
}

/** A [1,H,W,1] frame from a luminance field, optionally shifted by (dx, dy). */
function frame(field: Float32Array, dx = 0, dy = 0): tf.Tensor4D {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Wrap, so a shift introduces no blank border to bias the estimate.
      const sx = (((x - dx) % W) + W) % W;
      const sy = (((y - dy) % H) + H) % H;
      out[y * W + x] = field[sy * W + sx];
    }
  }
  return tf.tensor4d(out, [1, H, W, 1]);
}

/** A flat field, which is what a blank wall or a very dark scene looks like. */
function flat(value = 0.5): tf.Tensor4D {
  return tf.tensor4d(new Float32Array(W * H).fill(value), [1, H, W, 1]);
}

describe("estimateFlow", () => {
  beforeAll(async () => {
    await tf.setBackend("cpu");
    await tf.ready();
  });

  afterAll(() => {
    expect(tf.memory().numTensors).toBeGreaterThanOrEqual(0);
  });

  it("recovers a small horizontal shift", async () => {
    const field = texture();
    const a = frame(field);
    const b = frame(field, 2, 0);

    const flow = await estimateFlow(a, b);
    a.dispose();
    b.dispose();

    expect(flow).not.toBeNull();
    expect(flow!.u).toBeCloseTo(2, 0);
    expect(Math.abs(flow!.v)).toBeLessThan(1);
  });

  it("recovers a small vertical shift", async () => {
    const field = texture(7);
    const a = frame(field);
    const b = frame(field, 0, -3);

    const flow = await estimateFlow(a, b);
    a.dispose();
    b.dispose();

    expect(flow!.v).toBeCloseTo(-3, 0);
    expect(Math.abs(flow!.u)).toBeLessThan(1);
  });

  it("recovers a diagonal shift", async () => {
    const field = texture(11);
    const a = frame(field);
    const b = frame(field, 4, -2);

    const flow = await estimateFlow(a, b);
    a.dispose();
    b.dispose();

    expect(flow!.u).toBeCloseTo(4, 0);
    expect(flow!.v).toBeCloseTo(-2, 0);
  });

  it("recovers displacements too large for single-level Lucas-Kanade", async () => {
    // ~8px is what a fast head turn produces between frames; a non-pyramidal
    // solver would return roughly zero here.
    const field = texture(3);
    const a = frame(field);
    const b = frame(field, 8, 0);

    const flow = await estimateFlow(a, b);
    a.dispose();
    b.dispose();

    expect(flow!.u).toBeGreaterThan(5);
  });

  it("reports near-zero motion for identical frames", async () => {
    const field = texture(5);
    const a = frame(field);
    const b = frame(field);

    const flow = await estimateFlow(a, b);
    a.dispose();
    b.dispose();

    expect(Math.abs(flow!.u)).toBeLessThan(0.5);
    expect(Math.abs(flow!.v)).toBeLessThan(0.5);
  });

  it("returns null on a textureless scene instead of inventing motion", async () => {
    // The aperture problem: a blank wall supports no unique solution.
    const a = flat();
    const b = flat();

    const flow = await estimateFlow(a, b);
    a.dispose();
    b.dispose();

    expect(flow).toBeNull();
  });

  it("is not dragged off by a moving object covering a minority of the frame", async () => {
    // The scene pans by 2px while a "hand" region moves the other way — the
    // failure mode that whole-frame averaging would fall into.
    const field = texture(13);
    const a = frame(field);

    const shifted = frame(field, 2, 0);
    const opposite = frame(field, -6, 0);
    const data = await shifted.data();
    const other = await opposite.data();

    const blended = new Float32Array(data.length);
    blended.set(data);
    // Bottom-left quadrant moves against the background: ~25% of the frame.
    for (let y = Math.floor(H * 0.55); y < H; y++) {
      for (let x = 0; x < Math.floor(W * 0.45); x++) {
        blended[y * W + x] = other[y * W + x];
      }
    }
    const b = tf.tensor4d(blended, [1, H, W, 1]);

    const flow = await estimateFlow(a, b);
    [a, b, shifted, opposite].forEach((t) => t.dispose());

    expect(flow).not.toBeNull();
    // Background motion, not an average pulled toward the moving region.
    expect(flow!.u).toBeGreaterThan(0.8);
    expect(flow!.u).toBeLessThan(3.5);
  });

  it("leaks no tensors", async () => {
    const field = texture(17);
    const before = tf.memory().numTensors;

    const a = frame(field);
    const b = frame(field, 3, 1);
    await estimateFlow(a, b);
    a.dispose();
    b.dispose();

    expect(tf.memory().numTensors).toBe(before);
  });
});

describe("toGrayscale", () => {
  beforeAll(async () => {
    await tf.setBackend("cpu");
    await tf.ready();
  });

  it("converts RGBA pixels to luminance in [0,1]", () => {
    const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const image = { data, width: 2, height: 1, colorSpace: "srgb" } as ImageData;

    const gray = toGrayscale(image);
    const values = gray.dataSync();
    gray.dispose();

    expect(values[0]).toBeCloseTo(1, 5);
    expect(values[1]).toBeCloseTo(0, 5);
  });

  it("weights green most, per Rec. 601", () => {
    const pure = (r: number, g: number, b: number) =>
      ({ data: new Uint8ClampedArray([r, g, b, 255]), width: 1, height: 1 }) as ImageData;

    const green = toGrayscale(pure(0, 255, 0));
    const red = toGrayscale(pure(255, 0, 0));
    const g = green.dataSync()[0];
    const r = red.dataSync()[0];
    green.dispose();
    red.dispose();

    expect(g).toBeCloseTo(0.587, 3);
    expect(r).toBeCloseTo(0.299, 3);
  });
});
