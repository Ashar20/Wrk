/**
 * Hand detection on the server.
 *
 * The same self-hosted lite models the phone used, loaded from disk rather than
 * over HTTP: the validator must not depend on being able to reach its own web
 * server, and reading the files directly removes a network round trip from
 * every scoring run.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as handPoseDetection from "@tensorflow-models/hand-pose-detection";
import * as tf from "@tensorflow/tfjs";
import type { FrameHands, Landmark } from "@/lib/analysis/framing";

const MODEL_ROOT = () => fileURLToPath(new URL("../../../models/hand", import.meta.url));

/**
 * Custom scheme for models read off local disk.
 *
 * The wrapper insists its model URLs are strings — it inspects them before
 * handing them on — so an IOHandler cannot be passed directly. TFJS's load
 * router exists for this: register a scheme, return a handler for it, and pass
 * an ordinary string that resolves locally.
 */
const SCHEME = "wrkfile://";

/**
 * Loads a TFJS graph model from the filesystem.
 *
 * tfjs-node ships a file:// handler; the browser build does not, and adding
 * tfjs-node to pull in one function would drag a native binary into the server
 * bundle. The handler interface is small enough to implement.
 */
function fileHandler(modelJsonPath: string): tf.io.IOHandler {
  return {
    load: async () => {
      const manifest = JSON.parse(await readFile(modelJsonPath, "utf8"));
      const directory = dirname(modelJsonPath);

      const shards = manifest.weightsManifest.flatMap(
        (group: { paths: string[] }) => group.paths,
      ) as string[];

      const buffers = await Promise.all(
        shards.map(async (shard) => new Uint8Array(await readFile(join(directory, shard)))),
      );

      // The weights arrive as one contiguous buffer in manifest order.
      const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
      const weightData = new Uint8Array(total);
      let offset = 0;
      for (const buffer of buffers) {
        weightData.set(buffer, offset);
        offset += buffer.byteLength;
      }

      return {
        modelTopology: manifest.modelTopology,
        weightSpecs: manifest.weightsManifest.flatMap(
          (group: { weights: unknown[] }) => group.weights,
        ),
        weightData: weightData.buffer,
        format: manifest.format,
        generatedBy: manifest.generatedBy,
        convertedBy: manifest.convertedBy,
      } as tf.io.ModelArtifacts;
    },
  };
}

let routerRegistered = false;

function ensureRouter(): void {
  if (routerRegistered) return;
  // A router declines by returning null; the published type says IOHandler.
  tf.io.registerLoadRouter(((url: string | string[]) => {
    if (typeof url === "string" && url.startsWith(SCHEME)) {
      return fileHandler(url.slice(SCHEME.length));
    }
    return null;
  }) as unknown as Parameters<typeof tf.io.registerLoadRouter>[0]);
  routerRegistered = true;
}

let cached: Promise<handPoseDetection.HandDetector> | null = null;

export function serverDetector(): Promise<handPoseDetection.HandDetector> {
  ensureRouter();

  cached ??= handPoseDetection
    .createDetector(handPoseDetection.SupportedModels.MediaPipeHands, {
      runtime: "tfjs",
      modelType: "lite",
      maxHands: 2,
      detectorModelUrl: `${SCHEME}${join(MODEL_ROOT(), "detector", "model.json")}`,
      landmarkModelUrl: `${SCHEME}${join(MODEL_ROOT(), "landmark", "model.json")}`,
    })
    .catch((err: unknown) => {
      // Never cache a failure; a missing model file should stay retryable
      // after someone runs the setup script.
      cached = null;
      throw err;
    });

  return cached;
}

/**
 * RGBA pixels to an int32 RGB tensor.
 *
 * Node has no global ImageData, so tf.browser.fromPixels rejects the plain
 * object that stands in for one on the server. Tensors are accepted directly
 * and skip that path entirely.
 */
function toTensor(image: { data: Uint8ClampedArray; width: number; height: number }): tf.Tensor3D {
  const { data, width, height } = image;
  const rgb = new Int32Array(width * height * 3);

  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }

  return tf.tensor3d(rgb, [height, width, 3], "int32");
}

export async function detectHandsServerSide(
  frames: readonly { t: number; image: ImageData }[],
): Promise<FrameHands[]> {
  if (frames.length === 0) return [];

  const detector = await serverDetector();
  const out: FrameHands[] = [];

  for (const { t, image } of frames) {
    const tensor = toTensor(image);
    try {
      const found = await detector.estimateHands(tensor, { flipHorizontal: false });
      const hands: Landmark[][] = found.map((hand) =>
        hand.keypoints.map(({ x, y }) => ({ x: x / image.width, y: y / image.height })),
      );
      out.push({ t, hands });
    } finally {
      tensor.dispose();
    }
  }

  return out;
}
