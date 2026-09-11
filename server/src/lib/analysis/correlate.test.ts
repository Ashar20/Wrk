import { describe, expect, it } from "vitest";
import type { ImuSample } from "@/lib/capture/imu-codec";
import {
  gyroRatesOverIntervals,
  motionRms,
  pearson,
  plausibility,
  type FlowSample,
} from "./correlate";

const FRAME_MS = 1000 / 30;
const IMU_MS = 1000 / 60;

function imu(count: number, rate: (t: number) => { rx: number; ry: number }): ImuSample[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i * IMU_MS;
    const { rx, ry } = rate(t);
    return { t, ax: 0, ay: 0, az: 9.8125, rx, ry, rz: 0 };
  });
}

/** Flow that tracks the gyro, as genuine head-mounted capture produces. */
function flowFrom(
  count: number,
  rate: (t: number) => { rx: number; ry: number },
  { gain = -12, noise = 0 }: { gain?: number; noise?: number } = {},
): FlowSample[] {
  return Array.from({ length: count }, (_, i) => {
    const t0 = i * FRAME_MS;
    const t1 = t0 + FRAME_MS;
    const { rx, ry } = rate((t0 + t1) / 2);
    const jitter = noise === 0 ? 0 : Math.sin(i * 12.9898) * noise;
    // Horizontal image motion follows yaw, vertical follows pitch.
    return { t0, t1, u: ry * gain + jitter, v: rx * gain + jitter };
  });
}

const sweep = (t: number) => ({
  rx: Math.sin((t / 1000) * 2 * Math.PI * 0.4) * 25,
  ry: Math.cos((t / 1000) * 2 * Math.PI * 0.3) * 30,
});

describe("pearson", () => {
  it("returns 1 for a perfect positive relationship", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
  });

  it("returns -1 for a perfect inverse relationship", () => {
    expect(pearson([1, 2, 3, 4], [-2, -4, -6, -8])).toBeCloseTo(-1, 10);
  });

  it("returns null when a series has no variance", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it("returns null for fewer than two points", () => {
    expect(pearson([1], [1])).toBeNull();
  });

  it("is invariant to scale, which is why focal length is not needed", () => {
    const a = [1, 5, 2, 8, 3];
    const b = a.map((x) => x * 137.4);
    expect(pearson(a, b)).toBeCloseTo(1, 10);
  });
});

describe("gyroRatesOverIntervals", () => {
  it("averages IMU samples falling inside each frame interval", () => {
    const samples: ImuSample[] = [
      { t: 0, ax: 0, ay: 0, az: 0, rx: 2, ry: 10, rz: 0 },
      { t: 10, ax: 0, ay: 0, az: 0, rx: 4, ry: 20, rz: 0 },
      { t: 40, ax: 0, ay: 0, az: 0, rx: 100, ry: 100, rz: 0 },
    ];
    const [first] = gyroRatesOverIntervals(samples, [{ t0: 0, t1: 33.3 }]);

    expect(first).toEqual({ t: 16.65, wx: 3, wy: 15 });
  });

  it("yields null for an interval with no samples rather than interpolating", () => {
    const samples: ImuSample[] = [{ t: 0, ax: 0, ay: 0, az: 0, rx: 1, ry: 1, rz: 0 }];
    expect(gyroRatesOverIntervals(samples, [{ t0: 500, t1: 533 }])).toEqual([null]);
  });

  it("treats intervals as half-open so a sample is never counted twice", () => {
    const samples: ImuSample[] = [{ t: 100, ax: 0, ay: 0, az: 0, rx: 5, ry: 5, rz: 0 }];
    const [a, b] = gyroRatesOverIntervals(samples, [
      { t0: 50, t1: 100 },
      { t0: 100, t1: 150 },
    ]);
    expect(a).toBeNull();
    expect(b).not.toBeNull();
  });
});

describe("motionRms", () => {
  it("is zero for a motionless recording", () => {
    expect(motionRms([{ wx: 0, wy: 0 }])).toBe(0);
  });

  it("combines both axes", () => {
    expect(motionRms([{ wx: 3, wy: 4 }])).toBeCloseTo(5, 10);
  });
});

describe("plausibility", () => {
  it("scores genuine head-mounted capture near 100%", () => {
    const report = plausibility(flowFrom(60, sweep), imu(120, sweep));

    expect(report.verdict).toBe("ok");
    expect(report.percent).toBeGreaterThan(95);
  });

  it("scores a screen replay near zero, because its IMU is unrelated", () => {
    // Video of someone else's motion, phone held still-ish with idle jitter.
    const unrelated = (t: number) => ({
      rx: Math.sin(t * 0.7) * 20,
      ry: Math.cos(t * 1.31) * 20,
    });
    const report = plausibility(flowFrom(60, sweep), imu(120, unrelated));

    expect(report.verdict).toBe("ok");
    expect(report.percent!).toBeLessThan(40);
  });

  it("scores a synthesised IMU trace poorly", () => {
    const synthetic = () => ({ rx: 15, ry: 15 });
    const report = plausibility(flowFrom(60, sweep), imu(120, synthetic));
    // A constant trace has no variance to correlate against.
    expect(report.percent === null || report.percent < 40).toBe(true);
  });

  it("survives realistic flow noise", () => {
    const report = plausibility(flowFrom(60, sweep, { noise: 40 }), imu(120, sweep));
    expect(report.verdict).toBe("ok");
    expect(report.percent).toBeGreaterThan(70);
  });

  it("reports insufficient_motion rather than failing an honest still capture", () => {
    // The trap this guards: a tripod-still or slow capture is not a spoof, and
    // scoring near-zero correlation on noise would reject real contributions.
    const still = () => ({ rx: 0.2, ry: 0.15 });
    const report = plausibility(flowFrom(60, still), imu(120, still));

    expect(report.verdict).toBe("insufficient_motion");
    expect(report.percent).toBeNull();
    expect(report.motionRmsDegPerSec).toBeLessThan(3);
  });

  it("reports insufficient_frames when too little survived analysis", () => {
    const report = plausibility(flowFrom(3, sweep), imu(120, sweep));
    expect(report.verdict).toBe("insufficient_frames");
    expect(report.pairs).toBe(3);
  });

  it("drops frame intervals with no IMU coverage instead of inventing values", () => {
    // IMU stops a third of the way in — a real failure mode when the listener
    // is detached early or the sensor stalls.
    const report = plausibility(flowFrom(60, sweep), imu(40, sweep));
    expect(report.pairs).toBeLessThan(60);
    expect(report.pairs).toBeGreaterThan(8);
  });

  it("scores on magnitude, so a sign convention flip does not read as fake", () => {
    const positive = plausibility(flowFrom(60, sweep, { gain: 12 }), imu(120, sweep));
    const negative = plausibility(flowFrom(60, sweep, { gain: -12 }), imu(120, sweep));

    expect(positive.percent).toBeCloseTo(negative.percent!, 6);
  });

  it("weights axes by how much each actually moved", () => {
    // Yaw carries all the motion; a dead pitch axis must not halve the score.
    const yawOnly = (t: number) => ({ rx: 0, ry: Math.cos(t / 200) * 30 });
    const report = plausibility(flowFrom(60, yawOnly), imu(120, yawOnly));

    expect(report.verdict).toBe("ok");
    expect(report.percent).toBeGreaterThan(95);
  });

  it("returns a verdict rather than throwing on empty input", () => {
    expect(plausibility([], []).verdict).toBe("insufficient_frames");
  });
});
