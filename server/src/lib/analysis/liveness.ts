/**
 * Live head-movement check.
 *
 * Before a take the validator picks a random sequence of head movements ("look side to side", "nod up and down"),
 * and the app prompts for each at a known moment while recording. A real take shows the right movement at the right
 * time in BOTH the camera's picture and the phone's gyroscope. A replayed video or a fabricated motion trace can't,
 * because nobody knew the sequence when the footage was made.
 *
 * Checks the movement's AXIS, not its direction: left or right, up or down both count. Axis is independent of the
 * sign conventions that differ between phones, and it is what separates a head turn from a head nod.
 */

import type { FlowSample } from "./correlate";
import type { ImuSample } from "@/lib/capture/imu-codec";

export type Axis = "yaw" | "pitch";

export interface Prompt {
  /** Milliseconds from the start of recording at which the prompt appeared. */
  at_ms: number;
  axis: Axis;
}

export interface LivenessWindow {
  axis: Axis;
  matched: boolean;
  /** How much more the phone rotated about the asked-for axis than the other. */
  gyroDominance: number | null;
  /** The same for the picture's movement. */
  flowDominance: number | null;
}

export interface LivenessReport {
  total: number;
  matched: number;
  passed: boolean;
  windows: LivenessWindow[];
}

export interface LivenessOptions {
  /** Delay after a prompt before the movement is expected to start. */
  reactionMs?: number;
  /** How long after the prompt the movement may last. */
  windowMs?: number;
  /** The asked-for axis must carry this many times the energy of the other. */
  gyroRatio?: number;
  flowRatio?: number;
  /** Below this rotation speed (deg/s RMS) nothing meaningful happened. */
  minRmsDegPerSec?: number;
  /**
   * The movement's peak (its energy-weighted centre in time) must fall within this long after the reaction delay. This is
   * what rejects a recording that has the right movement but at the wrong moment.
   */
  centroidSpanMs?: number;
  /** Share of prompts that must match for the check to pass. */
  passShare?: number;
}

const DEFAULTS: Required<LivenessOptions> = { reactionMs: 300, windowMs: 3000, gyroRatio: 2, flowRatio: 1.5, minRmsDegPerSec: 6, centroidSpanMs: 2000, passShare: 0.6 };

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const ratio = (a: number, b: number) => (a + 1e-9) / (b + 1e-9);

/** Whether the right movement happened at each prompt, in both the picture and the gyroscope. */
export function checkLiveness(flow: readonly FlowSample[], imu: readonly ImuSample[], prompts: readonly Prompt[], options: LivenessOptions = {}): LivenessReport {
  const o = { ...DEFAULTS, ...options };
  const windows: LivenessWindow[] = prompts.map((p) => {
    const from = p.at_ms + o.reactionMs;
    const to = p.at_ms + o.windowMs;

    // Gyro: rx is rotation about the device's X axis (pitch), ry about Y (yaw). Same pairing the motion check uses.
    const g = imu.filter((s) => s.t >= from && s.t <= to);
    const f = flow.filter((s) => s.t0 >= from && s.t1 <= to);
    if (g.length < 10 || f.length < 3) return { axis: p.axis, matched: false, gyroDominance: null, flowDominance: null };

    const yaw = mean(g.map((s) => s.ry * s.ry));
    const pitch = mean(g.map((s) => s.rx * s.rx));
    const u = mean(f.map((s) => s.u * s.u)); // horizontal picture motion goes with yaw
    const v = mean(f.map((s) => s.v * s.v)); // vertical goes with pitch

    const want = p.axis === "yaw" ? yaw : pitch;
    const gyroDominance = p.axis === "yaw" ? ratio(yaw, pitch) : ratio(pitch, yaw);
    const flowDominance = p.axis === "yaw" ? ratio(u, v) : ratio(v, u);

    // When did the movement actually happen? Look a little either side of the window and find where its energy sits.
    // Prompts are at least 3.6 s apart, so up to 3.6 s after one is clear of the next prompt's own movement.
    const span = imu.filter((x) => x.t >= p.at_ms - 700 && x.t <= p.at_ms + 3600);
    const energy = span.map((x) => (p.axis === "yaw" ? x.ry * x.ry : x.rx * x.rx));
    const total = energy.reduce((a, b) => a + b, 0);
    const centroid = total > 0 ? span.reduce((a, x, i) => a + x.t * energy[i], 0) / total : null;
    const onTime = centroid !== null && centroid >= from && centroid <= from + o.centroidSpanMs;

    const matched = onTime && Math.sqrt(want) >= o.minRmsDegPerSec && gyroDominance >= o.gyroRatio && flowDominance >= o.flowRatio;
    return { axis: p.axis, matched, gyroDominance, flowDominance };
  });

  const matched = windows.filter((w) => w.matched).length;
  const total = windows.length;
  return { total, matched, windows, passed: total >= 2 && matched >= 2 && matched / total >= o.passShare };
}
