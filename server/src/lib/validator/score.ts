/**
 * Server-side scoring: every number that decides acceptance or payment is computed here from the
 * bytes that arrived, never taken from the client. Plausibility is optical flow versus gyroscope
 * correlation; framing is how much of the take had hands where the task needs them.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as tf from "@tensorflow/tfjs";
import {
  alignedTraces,
  plausibility,
  type AlignedTrace,
  type FlowSample,
  type PlausibilityReport,
} from "@/lib/analysis/correlate";
import { estimateFlow, toGrayscale } from "@/lib/analysis/flow";
import { checkLiveness, type LivenessReport, type Prompt } from "@/lib/analysis/liveness";
import {
  framingScore,
  type FrameHands,
  type FramingReport,
} from "@/lib/analysis/framing";
import { decodeImuStream, type ImuSample } from "@/lib/capture/imu-codec";
import { detectHandsServerSide } from "./detector";
import { dHash, episodeSignature } from "./phash";

const run = promisify(execFile);

/**
 * Sampling rate for analysis.
 *
 * Higher than the phone managed, and deliberately: flow needs frame pairs close
 * enough together that the motion between them stays inside the pyramid's
 * range, and the device could not afford this while also encoding.
 */
const SAMPLE_FPS = 8;
const MAX_FRAMES = 160;
const EDGE = 192;

/**
 * Hand detection runs on one sampled frame in this many.
 *
 * Detection dominates the cost — 121 frames took 164 seconds — while flow
 * needs consecutive pairs and framing does not need every frame. Scoring
 * every third frame still gives ~40 measurements across a 15s take, which
 * is more than the phone managed, at a third of the time.
 */
const DETECT_EVERY = 3;

export interface ScoreOptions {
  /** The head movements the contributor was asked for, when the task has a live check. */
  prompts?: Prompt[];
  /** Only decode, measure motion and run the live check. Skips hand detection and fingerprints: for a standalone live check. */
  livenessOnly?: boolean;
}

export interface Scores {
  /** Whether the asked-for movements appeared in both the picture and the gyroscope. Present only with prompts. */
  liveness?: LivenessReport;
  framing: FramingReport;
  plausibility: PlausibilityReport;
  /** The two traces at the best lag, for §6.3's overlay. Empty when unpaired. */
  traces: AlignedTrace[];
  signature: string[];
  framesAnalyzed: number;
  elapsedMs: number;
}

interface SampledFrame {
  t: number;
  image: ImageData;
}

async function probeSize(
  path: string,
): Promise<{ width: number; height: number }> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    path,
  ]);
  const [width, height] = stdout.trim().split(",").map(Number);
  return { width, height };
}

/**
 * The container, sniffed from the bytes. ffmpeg probes content rather than
 * extension so this changes no behaviour — it stops the temp file from
 * claiming an iPhone's MP4 is WebM while anyone is debugging one.
 */
function containerExtension(video: Uint8Array): string {
  // ISO-BMFF: a `ftyp` box at offset 4. Matroska/WebM: the EBML magic.
  if (
    video.length > 8 &&
    String.fromCharCode(...video.subarray(4, 8)) === "ftyp"
  )
    return "mp4";
  if (
    video.length > 4 &&
    video[0] === 0x1a &&
    video[1] === 0x45 &&
    video[2] === 0xdf &&
    video[3] === 0xa3
  )
    return "webm";
  return "bin";
}

export async function extractFrames(path: string): Promise<SampledFrame[]> {
  const { width, height } = await probeSize(path);
  if (!width || !height) return [];

  const scale = EDGE / Math.max(width, height);
  const w = Math.max(2, Math.round((width * scale) / 2) * 2);
  const h = Math.max(2, Math.round((height * scale) / 2) * 2);

  const { stdout } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      `fps=${SAMPLE_FPS},scale=${w}:${h}`,
      "-frames:v",
      String(MAX_FRAMES),
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-",
    ],
    { maxBuffer: 512 * 1024 * 1024, encoding: "buffer" },
  );

  const raw = stdout as unknown as Buffer;
  const stride = w * h * 4;
  const count = Math.floor(raw.length / stride);

  return Array.from({ length: count }, (_, i) => ({
    t: (i / SAMPLE_FPS) * 1000,
    image: {
      data: new Uint8ClampedArray(raw.subarray(i * stride, (i + 1) * stride)),
      width: w,
      height: h,
      colorSpace: "srgb",
    } as ImageData,
  }));
}

export async function flowSeries(frames: SampledFrame[]): Promise<FlowSample[]> {
  const out: FlowSample[] = [];
  if (frames.length < 2) return out;

  let prev = toGrayscale(frames[0].image);
  try {
    for (let i = 1; i < frames.length; i++) {
      const next = toGrayscale(frames[i].image);
      const dt = (frames[i].t - frames[i - 1].t) / 1000;
      const estimate = dt > 0 ? await estimateFlow(prev, next) : null;

      if (estimate) {
        out.push({
          t0: frames[i - 1].t,
          t1: frames[i].t,
          u: estimate.u / dt,
          v: estimate.v / dt,
        });
      }
      prev.dispose();
      prev = next;
    }
  } finally {
    prev.dispose();
  }
  return out;
}

/**
 * Score an episode from its uploaded bytes.
 *
 * Writes the video to a temp file because ffmpeg needs to seek, which it cannot
 * do on a pipe — the container's index lives at the end.
 */
export async function scoreEpisode(
  video: Uint8Array,
  imuBytes: Uint8Array,
  options: ScoreOptions = {},
): Promise<Scores> {
  const started = Date.now();
  const directory = await mkdtemp(join(tmpdir(), "wrk-"));
  const videoPath = join(directory, `episode.${containerExtension(video)}`);

  try {
    await writeFile(videoPath, video);
    await tf.setBackend("cpu");
    await tf.ready();

    const frames = await extractFrames(videoPath);
    if (frames.length === 0) {
      throw new Error("No frames could be decoded from the uploaded video.");
    }

    let imu: ImuSample[] = [];
    try {
      imu = decodeImuStream(imuBytes).samples;
    } catch {
      // A missing or corrupt IMU stream is a scoring failure, not a crash;
      // plausibility will report insufficient_frames and say so.
    }

    const flow = await flowSeries(frames);

    if (options.livenessOnly) {
      const none = { verdict: "no_frames" as const, percent: null, framesAnalyzed: 0, framesWithHands: 0, framesInGuide: 0, visibilityPercent: null };
      return {
        framing: none,
        liveness: checkLiveness(flow, imu, options.prompts ?? []),
        plausibility: plausibility(flow, imu),
        traces: [],
        signature: [],
        framesAnalyzed: frames.length,
        elapsedMs: Date.now() - started,
      };
    }

    const hands: FrameHands[] = await detectHandsServerSide(
      frames.filter((_, index) => index % DETECT_EVERY === 0),
    );

    const signature = episodeSignature(
      frames
        .map((frame) => {
          try {
            return dHash(frame.image);
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    );

    const report = plausibility(flow, imu);

    return {
      framing: framingScore(hands),
      liveness: options.prompts?.length ? checkLiveness(flow, imu, options.prompts) : undefined,
      plausibility: report,
      // At the lag the correlator actually chose, so the picture matches the
      // number rather than showing an unaligned pair beside a good score.
      traces: report.lagMs === null ? [] : alignedTraces(flow, imu, report.lagMs),
      signature,
      framesAnalyzed: frames.length,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
