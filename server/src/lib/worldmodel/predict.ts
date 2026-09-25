/**
 * One step of live prediction: a frame and a motion sample in, a guess at
 * what the wearer will see next out.
 *
 * This is product-spec §8.2's secondary demo item — "decode nearest-neighbour
 * frames from the latent predictions, show the model's guess at what the
 * wearer will see next" — made to run live, frame by frame, during capture
 * instead of once over a finished episode. See session-store.ts for why a
 * live guess can only point at a frame from earlier in the same take.
 */

import * as ort from "onnxruntime-node";
import { liveMeta, liveModel, liveModelAvailable } from "./live-model";
import { getOrCreateSession, pushBankEntry, type BankEntry } from "./session-store";

export interface PredictInput {
  sessionId: string;
  /** RGB, size*size*3 bytes, already the square crop live-meta.json's `size` expects. */
  rgb: Uint8Array;
  /** [ax, ay, az, rx, ry, rz] — the same order motion_tokens() in the trainer emits. */
  motion: readonly number[];
}

export interface PredictOutput {
  thumbnail: Uint8Array;
  thumbnailSize: number;
  /** Squared distance in standardised latent space — smaller is a closer match. */
  distance: number;
  bankSize: number;
  /** Too early in the take to have anything to compare against yet. */
  warming: boolean;
}

/** Cheap box downsample, no dependency: this runs on every streamed frame. */
export function downsample(rgb: Uint8Array, srcSize: number, dstSize: number): Uint8Array {
  const out = new Uint8Array(dstSize * dstSize * 3);
  const ratio = srcSize / dstSize;

  for (let y = 0; y < dstSize; y++) {
    const sy = Math.min(srcSize - 1, Math.floor(y * ratio));
    for (let x = 0; x < dstSize; x++) {
      const sx = Math.min(srcSize - 1, Math.floor(x * ratio));
      const si = (sy * srcSize + sx) * 3;
      const di = (y * dstSize + x) * 3;
      out[di] = rgb[si];
      out[di + 1] = rgb[si + 1];
      out[di + 2] = rgb[si + 2];
    }
  }
  return out;
}

/** uint8 RGB, HWC → normalised float32, CHW, batch of 1 — matches encoder.py exactly. */
export function toModelInput(rgb: Uint8Array, size: number, mean: readonly number[], std: readonly number[]): Float32Array {
  const chw = new Float32Array(3 * size * size);
  const plane = size * size;

  for (let i = 0; i < plane; i++) {
    const si = i * 3;
    chw[i] = (rgb[si] / 255 - mean[0]) / std[0];
    chw[plane + i] = (rgb[si + 1] / 255 - mean[1]) / std[1];
    chw[2 * plane + i] = (rgb[si + 2] / 255 - mean[2]) / std[2];
  }
  return chw;
}

export function squaredDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

export const THUMBNAIL_SIZE = 64;
/** Below this many prior frames, "nearest" is not a meaningful comparison. */
const MIN_BANK_FOR_A_GUESS = 2;

export async function predictNext(input: PredictInput): Promise<PredictOutput | null> {
  if (!liveModelAvailable()) return null;

  const meta = await liveMeta();
  if (input.rgb.length !== meta.size * meta.size * 3) {
    throw new Error(
      `Expected ${meta.size}x${meta.size} RGB (${meta.size * meta.size * 3} bytes), got ${input.rgb.length}.`,
    );
  }
  if (input.motion.length !== meta.motionDim) {
    throw new Error(`Expected ${meta.motionDim} motion values, got ${input.motion.length}.`);
  }

  const session = getOrCreateSession(input.sessionId, meta.hiddenSize);
  const model = await liveModel();

  const frameTensor = new ort.Tensor(
    "float32",
    toModelInput(input.rgb, meta.size, meta.imagenetMean, meta.imagenetStd),
    [1, 3, meta.size, meta.size],
  );
  const motionTensor = new ort.Tensor("float32", Float32Array.from(input.motion), [1, meta.motionDim]);
  const hiddenTensor = new ort.Tensor("float32", session.hidden, [1, 1, meta.hiddenSize]);

  const { predicted, current, hidden_next } = await model.run({
    frame: frameTensor,
    motion: motionTensor,
    hidden: hiddenTensor,
  });

  session.hidden = Float32Array.from(hidden_next.data as Float32Array);

  const thumbnail = downsample(input.rgb, meta.size, THUMBNAIL_SIZE);
  const entry: BankEntry = {
    latentStd: Float32Array.from(current.data as Float32Array),
    thumbnail,
    thumbnailSize: THUMBNAIL_SIZE,
    capturedAtMs: Date.now(),
  };

  const bankBefore = session.bank.length;
  pushBankEntry(session, entry);

  if (bankBefore < MIN_BANK_FOR_A_GUESS) {
    return { thumbnail, thumbnailSize: THUMBNAIL_SIZE, distance: 0, bankSize: session.bank.length, warming: true };
  }

  const predictedLatent = Float32Array.from(predicted.data as Float32Array);
  let best: BankEntry = session.bank[0];
  let bestDistance = Infinity;

  for (const candidate of session.bank) {
    const distance = squaredDistance(predictedLatent, candidate.latentStd);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return {
    thumbnail: best.thumbnail,
    thumbnailSize: best.thumbnailSize,
    distance: bestDistance,
    bankSize: session.bank.length,
    warming: false,
  };
}
