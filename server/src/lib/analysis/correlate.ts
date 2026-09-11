/**
 * Flow-vs-gyro plausibility scoring.
 *
 * Head motion shows up in two independent streams: the camera's image moves,
 * and the gyroscope reads angular velocity. Genuine head-mounted capture makes
 * those track each other. A screen replay, stock footage, or a synthesised IMU
 * trace does not. This is product-spec §6.3's check, computed on-device.
 *
 * Three decisions worth stating:
 *
 *  - **Scale-invariance saves us from needing the field of view.** Converting
 *    pixel flow into an angle requires focal length in pixels, which the web
 *    exposes nowhere. Pearson correlation is invariant to linear scaling, so
 *    raw pixel rates can be correlated against deg/s directly and the unknown
 *    focal length cancels.
 *  - **Magnitude, not sign.** Whether yaw-right moves the image left or right
 *    depends on device and orientation conventions we deliberately do not
 *    normalise on-device. A spoof produces r near zero, not r near -1, so |r|
 *    is the statistic that separates real from fake. Signs are reported so a
 *    convention can be pinned later.
 *  - **Low motion means undefined, not fake.** Correlation over a near-still
 *    recording is dominated by noise. Scoring that as a low number would fail
 *    honest captures, so it returns a distinct verdict instead.
 *  - **The lag is estimated, not assumed.** Frames and IMU samples are stamped
 *    from different clocks and the offset between them is not zero. Measured on
 *    a real episode: correlation at zero offset was 0.42, and 0.69 once a 250ms
 *    lag was corrected — the difference between failing the bar and passing it.
 *
 * **Peak prominence, not peak height, is what separates real from fake.**
 * Searching over lags gives any pairing several chances at a spurious
 * correlation, so a high score alone proves little. Genuine capture produces a
 * sharp peak at one lag with noise either side; unrelated streams produce the
 * same middling noise everywhere. The ratio of the best lag to the typical lag
 * is therefore reported and used, and it is the statistic a spoof cannot fake
 * without actually having been filmed by the phone that moved.
 */

import type { ImuSample } from "@/lib/capture/imu-codec";

/** Image motion between two frames, in pixels per second over [t0, t1]. */
export interface FlowSample {
  /** Start of the frame interval, ms from recording start. */
  t0: number;
  /** End of the frame interval, ms from recording start. */
  t1: number;
  /** Horizontal image rate, px/s. Pairs with yaw. */
  u: number;
  /** Vertical image rate, px/s. Pairs with pitch. */
  v: number;
}

export type PlausibilityVerdict = "ok" | "insufficient_motion" | "insufficient_frames";

export interface PlausibilityReport {
  verdict: PlausibilityVerdict;
  /** 0–100 for display, null when no verdict was reached. */
  percent: number | null;
  /** Combined |r| across axes at the best lag, 0–1. */
  correlation: number | null;
  perAxis: { yaw: number | null; pitch: number | null };
  pairs: number;
  motionRmsDegPerSec: number;
  /** Estimated offset between the frame and IMU clocks, milliseconds. */
  lagMs: number | null;
  /**
   * How far the best lag stands above the typical one. Around 1 means a flat
   * sweep — no sync anywhere — which is what an unrelated pairing produces.
   */
  peakProminence: number | null;
}

export interface PlausibilityOptions {
  /** Below this gyro RMS the correlation is noise, not evidence. */
  minMotionRmsDegPerSec?: number;
  minPairs?: number;
  /**
   * Widest lag considered, milliseconds. Bounded on purpose: a wider search
   * finds more spurious peaks, and an offset beyond this is a broken client
   * rather than ordinary clock skew.
   */
  maxLagMs?: number;
  /** Step between candidate lags. */
  lagStepMs?: number;
}

const DEFAULTS = {
  minMotionRmsDegPerSec: 3,
  minPairs: 8,
  maxLagMs: 500,
  lagStepMs: 50,
} as const;

/** Pearson correlation. Null when either series has no variance. */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  const denom = Math.sqrt(sxx * syy);
  if (denom === 0) return null;

  const r = sxy / denom;
  // Guard against floating-point excursions past ±1.
  return Math.max(-1, Math.min(1, r));
}

/**
 * Mean angular rate over each [t_i, t_{i+1}] interval, sampled from the IMU.
 *
 * Frames and IMU samples run at different rates on different clocks; this puts
 * the gyro onto the frame pairs' timeline so the two can be compared term by
 * term. Intervals containing no IMU sample yield null and are dropped by the
 * caller rather than interpolated into existence.
 */
export function gyroRatesOverIntervals(
  samples: readonly ImuSample[],
  intervals: ReadonlyArray<{ t0: number; t1: number }>,
  lagMs = 0,
): Array<{ t: number; wx: number; wy: number } | null> {
  return intervals.map(({ t0, t1 }) => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (const s of samples) {
      const t = s.t + lagMs;
      if (t >= t0 && t < t1) {
        n++;
        sx += s.rx;
        sy += s.ry;
      }
    }
    return n === 0 ? null : { t: (t0 + t1) / 2, wx: sx / n, wy: sy / n };
  });
}

/** RMS angular speed across the pitch/yaw axes, deg/s. */
export function motionRms(rates: ReadonlyArray<{ wx: number; wy: number }>): number {
  if (rates.length === 0) return 0;
  let acc = 0;
  for (const r of rates) acc += r.wx * r.wx + r.wy * r.wy;
  return Math.sqrt(acc / rates.length);
}

/** Correlation between flow and gyro at one candidate lag. */
/**
 * The two traces, aligned at a given lag, for showing side by side.
 *
 * product-spec §6.3 asks for the flow and gyro traces overlaid, and demo scene
 * 3 turns on them visibly diverging for a replay. The correlation number is
 * the claim; this is the evidence a viewer can check without trusting it.
 *
 * Each channel is scaled independently to [-1, 1]. They are in different units
 * — flow in pixels per second, gyro in degrees per second — and no fixed
 * conversion exists without the camera's focal length, which a browser does not
 * expose. What the check measures is whether the two move *together*, so the
 * chart shows shape and deliberately not magnitude.
 */
export interface AlignedTrace {
  t: number;
  flowYaw: number;
  gyroYaw: number;
  flowPitch: number;
  gyroPitch: number;
}

export function alignedTraces(
  flow: readonly FlowSample[],
  imu: readonly ImuSample[],
  lagMs: number,
  maxPoints = 160,
): AlignedTrace[] {
  const gyro = gyroRatesOverIntervals(imu, flow, lagMs);

  const rows: Array<{ t: number; u: number; v: number; wx: number; wy: number }> = [];
  for (let i = 0; i < flow.length; i++) {
    const g = gyro[i];
    if (!g) continue;
    rows.push({ t: flow[i].t0, u: flow[i].u, v: flow[i].v, wx: g.wx, wy: g.wy });
  }
  if (rows.length === 0) return [];

  const norm = (values: number[]): number[] => {
    const peak = Math.max(...values.map(Math.abs));
    return peak > 0 ? values.map((v) => v / peak) : values.map(() => 0);
  };

  const flowYaw = norm(rows.map((r) => r.u));
  const gyroYaw = norm(rows.map((r) => r.wy));
  const flowPitch = norm(rows.map((r) => r.v));
  const gyroPitch = norm(rows.map((r) => r.wx));

  // Even stride rather than a head slice: a truncated trace would hide exactly
  // the divergence at the end of a take that this is meant to reveal.
  const stride = Math.max(1, Math.ceil(rows.length / maxPoints));
  const out: AlignedTrace[] = [];
  for (let i = 0; i < rows.length; i += stride) {
    out.push({
      t: Math.round(rows[i].t),
      flowYaw: Number(flowYaw[i].toFixed(4)),
      gyroYaw: Number(gyroYaw[i].toFixed(4)),
      flowPitch: Number(flowPitch[i].toFixed(4)),
      gyroPitch: Number(gyroPitch[i].toFixed(4)),
    });
  }
  return out;
}

function scoreAtLag(
  flow: readonly FlowSample[],
  imu: readonly ImuSample[],
  lagMs: number,
  minPairs: number,
): { combined: number; yaw: number | null; pitch: number | null; pairs: number; rms: number } {
  const gyro = gyroRatesOverIntervals(imu, flow, lagMs);

  const us: number[] = [];
  const vs: number[] = [];
  const wxs: number[] = [];
  const wys: number[] = [];

  for (let i = 0; i < flow.length; i++) {
    const g = gyro[i];
    if (!g) continue;
    us.push(flow[i].u);
    vs.push(flow[i].v);
    wxs.push(g.wx);
    wys.push(g.wy);
  }

  const rms = motionRms(wxs.map((wx, i) => ({ wx, wy: wys[i] })));
  if (us.length < minPairs) return { combined: 0, yaw: null, pitch: null, pairs: us.length, rms };

  const yaw = pearson(us, wys);
  const pitch = pearson(vs, wxs);

  // Weight each axis by how much the gyro actually moved on it, so an axis
  // with no real motion cannot dilute a good score on the axis that carried it.
  const wYaw = variance(wys);
  const wPitch = variance(wxs);
  const parts: Array<[number, number]> = [];
  if (yaw !== null && wYaw > 0) parts.push([Math.abs(yaw), wYaw]);
  if (pitch !== null && wPitch > 0) parts.push([Math.abs(pitch), wPitch]);

  if (parts.length === 0) return { combined: 0, yaw, pitch, pairs: us.length, rms };

  const total = parts.reduce((acc, [, w]) => acc + w, 0);
  const combined = parts.reduce((acc, [r, w]) => acc + r * w, 0) / total;

  return { combined, yaw, pitch, pairs: us.length, rms };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function plausibility(
  flow: readonly FlowSample[],
  imu: readonly ImuSample[],
  options: PlausibilityOptions = {},
): PlausibilityReport {
  const { minMotionRmsDegPerSec, minPairs, maxLagMs, lagStepMs } = { ...DEFAULTS, ...options };

  const lags: number[] = [];
  for (let lag = -maxLagMs; lag <= maxLagMs; lag += lagStepMs) lags.push(lag);

  const swept = lags.map((lag) => ({ lag, ...scoreAtLag(flow, imu, lag, minPairs) }));
  const atZero = swept.find((s) => s.lag === 0) ?? swept[0];
  const best = swept.reduce((a, b) => (b.combined > a.combined ? b : a), swept[0]);

  if (atZero.pairs < minPairs) {
    return {
      verdict: "insufficient_frames",
      percent: null,
      correlation: null,
      perAxis: { yaw: null, pitch: null },
      pairs: atZero.pairs,
      motionRmsDegPerSec: atZero.rms,
      lagMs: null,
      peakProminence: null,
    };
  }

  if (atZero.rms < minMotionRmsDegPerSec) {
    return {
      verdict: "insufficient_motion",
      percent: null,
      correlation: null,
      perAxis: { yaw: null, pitch: null },
      pairs: atZero.pairs,
      motionRmsDegPerSec: atZero.rms,
      lagMs: null,
      peakProminence: null,
    };
  }

  // A flat sweep means no synchronisation at any lag, which is what unrelated
  // streams look like. A genuine capture peaks at one lag and falls away.
  const typical = median(swept.map((s) => s.combined));
  const prominence = typical > 0 ? best.combined / typical : best.combined > 0 ? Infinity : 1;

  // Prominence is reported rather than applied. Discounting by it was tried
  // and rejected: smooth, narrowband motion correlates well at every nearby
  // lag and so is legitimately unprominent, and the discount punished honest
  // captures for the shape of their movement. Whether it separates real from
  // fake is measured in spoof.test.ts, not assumed here.
  return {
    verdict: "ok",
    percent: Math.round(best.combined * 1000) / 10,
    correlation: best.combined,
    perAxis: { yaw: best.yaw, pitch: best.pitch },
    pairs: best.pairs,
    motionRmsDegPerSec: best.rms,
    lagMs: best.lag,
    peakProminence: Number.isFinite(prominence) ? Math.round(prominence * 100) / 100 : null,
  };
}

function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / xs.length;
}
