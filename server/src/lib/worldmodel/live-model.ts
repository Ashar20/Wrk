/**
 * Loading the exported world model, once, for live inference during capture.
 *
 * The ONNX graph and its metadata are written by trainer/export_live.py from
 * whichever episodes exist when it last ran — see that file's header for why
 * the frozen encoder is baked into the graph rather than swapped for a
 * separate browser-side copy. Both files are gitignored, the same as the hand
 * detector's weights: they are trainer output, not source, and a fresh
 * checkout has neither until someone runs the exporter.
 *
 * That absence is not an error. Live prediction is additive on top of a
 * marketplace that works without it — a missing model disables the overlay
 * during capture and nothing else, the same way a missing relayer key
 * disables anchoring and nothing else.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";

const MODEL_ROOT = () => fileURLToPath(new URL("../../../models/live", import.meta.url));

export interface LiveMeta {
  size: number;
  latentDim: number;
  hiddenSize: number;
  motionDim: number;
  horizon: number;
  trainEpisodes: number;
  heldoutEpisodes: number;
  heldoutError: number;
  baselineError: number;
  imagenetMean: [number, number, number];
  imagenetStd: [number, number, number];
}

export function liveModelAvailable(): boolean {
  return existsSync(join(MODEL_ROOT(), "live.onnx")) && existsSync(join(MODEL_ROOT(), "live-meta.json"));
}

let cachedMeta: LiveMeta | null = null;

export async function liveMeta(): Promise<LiveMeta> {
  if (cachedMeta) return cachedMeta;
  const raw = await readFile(join(MODEL_ROOT(), "live-meta.json"), "utf8");
  cachedMeta = JSON.parse(raw) as LiveMeta;
  return cachedMeta;
}

let cachedSession: Promise<ort.InferenceSession> | null = null;

export function liveModel(): Promise<ort.InferenceSession> {
  // Never cache a failure: a model exported moments after a failed load
  // should not require a server restart to be picked up.
  cachedSession ??= ort.InferenceSession.create(join(MODEL_ROOT(), "live.onnx"), {
    executionProviders: ["cpu"],
  }).catch((err: unknown) => {
    cachedSession = null;
    throw err;
  });
  return cachedSession;
}
