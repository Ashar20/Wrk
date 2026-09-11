/**
 * Optical flow estimation with TensorFlow.js.
 *
 * Produces the image-motion half of the flow-vs-gyro check. Three properties
 * matter more than raw accuracy here:
 *
 *  - **Robustness to the thing being recorded.** In a head-mounted
 *    manipulation clip a large part of the frame is a moving hand and object.
 *    Averaging flow over the whole frame would measure the cup as much as the
 *    head. Flow is therefore solved per block on a grid and combined with a
 *    MEDIAN, so a minority of blocks moving independently cannot drag the
 *    estimate. That is the cheap stand-in for RANSAC.
 *  - **Displacements larger than a pixel.** Plain Lucas-Kanade assumes
 *    sub-pixel motion. A 30 deg/s head turn at 30fps moves a 160px-wide frame
 *    by roughly 3px, well outside that. A coarse-to-fine pyramid brings each
 *    level's residual back inside the linear regime.
 *  - **Refusing to answer.** Blocks without enough texture produce an
 *    ill-conditioned system whose "solution" is noise. Those are dropped, and
 *    if too few survive the estimate is null rather than fabricated.
 */

import * as tf from "@tensorflow/tfjs";

export interface FlowEstimate {
  /** Horizontal displacement in pixels, at full input resolution. */
  u: number;
  /** Vertical displacement in pixels. */
  v: number;
  /** Fraction of blocks that were well-conditioned enough to contribute, 0–1. */
  confidence: number;
}

export interface FlowOptions {
  /** Pyramid levels, including the full-resolution one. */
  levels?: number;
  /** Block edge in pixels at each level. */
  blockSize?: number;
  /** Minimum eigenvalue of the structure tensor for a block to count. */
  minEigenvalue?: number;
  /** Fraction of blocks that must survive for an estimate to be returned. */
  minUsableBlocks?: number;
}

const DEFAULTS = {
  levels: 3,
  blockSize: 16,
  minEigenvalue: 1e-3,
  minUsableBlocks: 0.15,
} as const;

/**
 * Pixels discarded from each edge before blocks are formed.
 *
 * Two artefacts live there: conv2d "same" zero-pads, so Sobel reads a hard
 * edge at the frame boundary even on a blank wall, and the integer shift
 * pulls empty rows in from one side. Both look like strong texture and would
 * otherwise let a textureless scene report confident motion.
 */
const BORDER_MARGIN = 6;

/**
 * Grayscale from an already-rasterised canvas, without a CPU readback.
 *
 * getImageData is the expensive step — a synchronous GPU-to-CPU transfer that
 * flushes the rendering pipeline. Measured on an S24 while recording: 46 gaps
 * longer than 1.5x the frame interval and one 1330ms hole with no video at
 * all, in the middle of the motion the validator needs most.
 *
 * The canvas is the source rather than the video element on purpose. Android
 * delivers a hardware-decoded video texture that fromPixels can read as empty
 * without raising anything, which stops tracking silently; drawing through a
 * canvas first is cheap and always rasterises.
 */
export function grayscaleFromCanvas(canvas: HTMLCanvasElement): tf.Tensor4D {
  return tf.tidy(() => {
    const rgb = tf.browser.fromPixels(canvas);
    const weights = tf.tensor1d([0.299, 0.587, 0.114]);
    return rgb.div(255).mul(weights).sum(2).expandDims(0).expandDims(3) as tf.Tensor4D;
  });
}

/** Grayscale luminance in [0,1] as a [1,H,W,1] tensor. */
export function toGrayscale(image: ImageData): tf.Tensor4D {
  return tf.tidy(() => {
    const rgba = tf.tensor3d(
      new Float32Array(image.data),
      [image.height, image.width, 4],
      "float32",
    );
    const rgb = rgba.slice([0, 0, 0], [image.height, image.width, 3]).div(255);
    // Rec. 601 luma.
    const weights = tf.tensor1d([0.299, 0.587, 0.114]);
    return rgb.mul(weights).sum(2).expandDims(0).expandDims(3) as tf.Tensor4D;
  });
}

function pyramid(gray: tf.Tensor4D, levels: number): tf.Tensor4D[] {
  const out: tf.Tensor4D[] = [gray];
  for (let i = 1; i < levels; i++) {
    const prev = out[i - 1];
    const [, h, w] = prev.shape;
    if (h < 32 || w < 32) break;
    out.push(tf.avgPool(prev, [2, 2], [2, 2], "valid") as tf.Tensor4D);
  }
  return out;
}

const SOBEL_X = [
  [-1, 0, 1],
  [-2, 0, 2],
  [-1, 0, 1],
];
const SOBEL_Y = [
  [-1, -2, -1],
  [0, 0, 0],
  [1, 2, 1],
];

function gradients(gray: tf.Tensor4D): { ix: tf.Tensor4D; iy: tf.Tensor4D } {
  return tf.tidy(() => {
    const kx = tf.tensor4d(SOBEL_X.flat(), [3, 3, 1, 1]).div(8);
    const ky = tf.tensor4d(SOBEL_Y.flat(), [3, 3, 1, 1]).div(8);
    return {
      ix: tf.conv2d(gray, kx as tf.Tensor4D, 1, "same") as tf.Tensor4D,
      iy: tf.conv2d(gray, ky as tf.Tensor4D, 1, "same") as tf.Tensor4D,
    };
  });
}

/** Integer-pixel shift, so each pyramid level solves only a small residual. */
function shift(image: tf.Tensor4D, dx: number, dy: number): tf.Tensor4D {
  if (dx === 0 && dy === 0) return image.clone();

  return tf.tidy(() => {
    const [, h, w] = image.shape;
    // Pad then crop: cheaper and clearer than assembling slices by hand.
    const padY = Math.abs(dy);
    const padX = Math.abs(dx);
    const padded = tf.pad(image, [
      [0, 0],
      [padY, padY],
      [padX, padX],
      [0, 0],
    ]) as tf.Tensor4D;
    const startY = padY - dy;
    const startX = padX - dx;
    return tf.slice(padded, [0, startY, startX, 0], [1, h, w, 1]) as tf.Tensor4D;
  });
}

/** Per-block sums over the frame interior, via a mean pool scaled by window area. */
function blockSums(t: tf.Tensor4D, block: number): tf.Tensor4D {
  return tf.tidy(() => {
    const [, h, w] = t.shape;
    const m = Math.min(BORDER_MARGIN, Math.floor(Math.min(h, w) / 4));
    const interior = tf.slice(t, [0, m, m, 0], [1, h - 2 * m, w - 2 * m, 1]) as tf.Tensor4D;
    return tf.avgPool(interior, [block, block], [block, block], "valid").mul(
      block * block,
    ) as tf.Tensor4D;
  });
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Solve the residual flow at one pyramid level, given the current estimate.
 * Returns null when too few blocks are well-conditioned.
 */
async function solveLevel(
  prev: tf.Tensor4D,
  next: tf.Tensor4D,
  guessX: number,
  guessY: number,
  opts: Required<FlowOptions>,
): Promise<{ du: number; dv: number; usable: number } | null> {
  const [, h, w] = prev.shape;
  const block = Math.min(opts.blockSize, Math.floor(Math.min(h, w) / 2));
  if (block < 4) return null;

  const aligned = shift(next, -Math.round(guessX), -Math.round(guessY));

  const sums = tf.tidy(() => {
    const { ix, iy } = gradients(prev);
    const it = aligned.sub(prev) as tf.Tensor4D;
    return {
      ixx: blockSums(ix.mul(ix) as tf.Tensor4D, block),
      iyy: blockSums(iy.mul(iy) as tf.Tensor4D, block),
      ixy: blockSums(ix.mul(iy) as tf.Tensor4D, block),
      ixt: blockSums(ix.mul(it) as tf.Tensor4D, block),
      iyt: blockSums(iy.mul(it) as tf.Tensor4D, block),
    };
  });
  aligned.dispose();

  const [ixx, iyy, ixy, ixt, iyt] = await Promise.all([
    sums.ixx.data(),
    sums.iyy.data(),
    sums.ixy.data(),
    sums.ixt.data(),
    sums.iyt.data(),
  ]);
  Object.values(sums).forEach((t) => t.dispose());

  const us: number[] = [];
  const vs: number[] = [];
  const total = ixx.length;

  for (let i = 0; i < total; i++) {
    const a = ixx[i];
    const b = ixy[i];
    const d = iyy[i];

    // Eigenvalues of the 2x2 structure tensor [[a,b],[b,d]]. The smaller one
    // says whether this block has texture in BOTH directions; if it does not,
    // the system is ill-conditioned and its solution is noise (the aperture
    // problem — a plain wall or a single straight edge).
    const trace = a + d;
    const det = a * d - b * b;
    const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
    const minEig = trace / 2 - disc;
    if (minEig < opts.minEigenvalue || det === 0) continue;

    // [[a,b],[b,d]] [u;v] = -[ixt; iyt]
    const u = (-d * ixt[i] + b * iyt[i]) / det;
    const v = (b * ixt[i] - a * iyt[i]) / det;
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;

    us.push(u);
    vs.push(v);
  }

  const usable = total === 0 ? 0 : us.length / total;
  if (us.length === 0 || usable < opts.minUsableBlocks) return null;

  // Median, not mean: a moving hand occupying a minority of blocks must not
  // move the estimate.
  return { du: medianOf(us), dv: medianOf(vs), usable };
}

/**
 * Estimate global image displacement between two frames, in pixels.
 *
 * Returns null rather than a number when the frames carry too little texture
 * to support an answer — a blank wall or a very dark scene.
 */
export async function estimateFlow(
  prevGray: tf.Tensor4D,
  nextGray: tf.Tensor4D,
  options: FlowOptions = {},
): Promise<FlowEstimate | null> {
  const opts = { ...DEFAULTS, ...options };

  const prevPyr = pyramid(prevGray, opts.levels);
  const nextPyr = pyramid(nextGray, opts.levels);

  try {
    let u = 0;
    let v = 0;
    let confidence = 0;
    let solvedAny = false;

    // Coarse to fine: each level halves the residual the next must explain.
    for (let level = prevPyr.length - 1; level >= 0; level--) {
      const scale = 2 ** level;
      let levelU = u / scale;
      let levelV = v / scale;

      // Several passes per level: early ones close the gap, later ones refine.
      for (let iter = 0; iter < 4; iter++) {
        const solved = await solveLevel(prevPyr[level], nextPyr[level], levelU, levelV, opts);
        if (!solved) break;
        levelU += solved.du;
        levelV += solved.dv;
        confidence = solved.usable;
        solvedAny = true;
      }

      u = levelU * scale;
      v = levelV * scale;
    }

    return solvedAny ? { u, v, confidence } : null;
  } finally {
    prevPyr.slice(1).forEach((t) => t.dispose());
    nextPyr.slice(1).forEach((t) => t.dispose());
  }
}
