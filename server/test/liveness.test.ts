import { describe, expect, it } from "vitest";
import { checkLiveness, type Axis, type Prompt } from "@/lib/analysis/liveness";
import type { FlowSample } from "@/lib/analysis/correlate";
import type { ImuSample } from "@/lib/capture/imu-codec";
import { LivenessChallenges, LivenessError, MIN_GAP_MS, MIN_PROMPTS, PROMPT_COUNT } from "../src/liveness";

const DURATION = 15_000;
const TIMES = [2200, 6400, 10700];

/** A head that moves about [axis] for 2.5 s after each prompt, with a little noise elsewhere. */
function head(prompts: Prompt[], opts: { amp?: number; skip?: number[]; noise?: number } = {}) {
  const amp = opts.amp ?? 45; const noise = opts.noise ?? 1.5;
  const at = (t: number): { axis: Axis; k: number } | null => {
    for (let k = 0; k < prompts.length; k++) {
      if (opts.skip?.includes(k)) continue;
      const w = t - prompts[k].at_ms - 300;
      if (w >= 0 && w <= 2500) return { axis: prompts[k].axis, k };
    }
    return null;
  };
  const wave = (t: number, k: number) => Math.sin((2 * Math.PI * (t - prompts[k].at_ms - 300)) / 1250);
  const rand = (i: number) => Math.sin(i * 12.9898) * 43758.5453 % 1; // deterministic noise

  const imu: ImuSample[] = [];
  for (let i = 0; i * 10 <= DURATION; i++) {
    const t = i * 10; const m = at(t);
    const yaw = m?.axis === "yaw" ? amp * wave(t, m.k) : noise * rand(i);
    const pitch = m?.axis === "pitch" ? amp * wave(t, m.k) : noise * rand(i + 7);
    imu.push({ t, ax: 0, ay: 9.8, az: 0, rx: pitch, ry: yaw, rz: 0 });
  }
  // The picture moves with the head: horizontal for a turn, vertical for a nod (px/s, an arbitrary camera scale).
  const flow: FlowSample[] = [];
  for (let i = 0; i * 125 + 125 <= DURATION; i++) {
    const t0 = i * 125; const t1 = t0 + 125; const m = at(t0 + 60);
    const u = m?.axis === "yaw" ? 12 * amp * wave(t0, m.k) : 4 * rand(i + 3);
    const v = m?.axis === "pitch" ? 12 * amp * wave(t0, m.k) : 4 * rand(i + 11);
    flow.push({ t0, t1, u, v });
  }
  return { imu, flow };
}

const asked = (axes: Axis[]): Prompt[] => axes.map((axis, i) => ({ at_ms: TIMES[i], axis }));

describe("live head-movement check", () => {
  const prompts = asked(["yaw", "pitch", "yaw"]);

  it("passes a take where the head did what was asked, in both the picture and the gyroscope", () => {
    const { imu, flow } = head(prompts);
    const r = checkLiveness(flow, imu, prompts);
    expect(r).toMatchObject({ total: 3, matched: 3, passed: true });
    expect(r.windows.every((w) => (w.gyroDominance ?? 0) >= 2 && (w.flowDominance ?? 0) >= 1.5)).toBe(true);
  });

  it("fails a replay: real footage made for a different sequence than the one asked", () => {
    const other = asked(["pitch", "yaw", "pitch"]);
    const { imu, flow } = head(other); // genuine, but nobody knew this sequence when it was recorded
    const r = checkLiveness(flow, imu, prompts);
    expect(r.matched).toBe(0); expect(r.passed).toBe(false);
  });

  it("fails a recording where the same movements happen but at the wrong moments", () => {
    for (const shift of [1800, -1800, 1500, 1200]) {
      const moved = prompts.map((p) => ({ ...p, at_ms: p.at_ms + shift }));
      const { imu, flow } = head(moved);
      expect(checkLiveness(flow, imu, prompts).passed, `shifted ${shift} ms`).toBe(false);
    }
  });

  it("still passes someone a little slow or quick to react", () => {
    for (const shift of [-300, 300, 600]) {
      const moved = prompts.map((p) => ({ ...p, at_ms: p.at_ms + shift }));
      const { imu, flow } = head(moved);
      expect(checkLiveness(flow, imu, prompts).passed, `shifted ${shift} ms`).toBe(true);
    }
  });

  it("fails when the gyroscope is right but the picture isn't (fabricated motion over a replayed video)", () => {
    const { imu } = head(prompts);
    const { flow } = head(asked(["pitch", "yaw", "pitch"]));
    const r = checkLiveness(flow, imu, prompts);
    expect(r.passed).toBe(false); expect(r.matched).toBe(0);
  });

  it("fails when the picture is right but the gyroscope isn't (fabricated video over real motion)", () => {
    const { flow } = head(prompts);
    const { imu } = head(asked(["pitch", "yaw", "pitch"]));
    expect(checkLiveness(flow, imu, prompts).passed).toBe(false);
  });

  it("fails someone who didn't move", () => {
    const { imu, flow } = head(prompts, { amp: 0 });
    expect(checkLiveness(flow, imu, prompts)).toMatchObject({ matched: 0, passed: false });
  });

  it("fails movement too small to mean anything", () => {
    const { imu, flow } = head(prompts, { amp: 4 });
    expect(checkLiveness(flow, imu, prompts).passed).toBe(false);
  });

  it("forgives one missed prompt out of three", () => {
    const { imu, flow } = head(prompts, { skip: [1] });
    expect(checkLiveness(flow, imu, prompts)).toMatchObject({ total: 3, matched: 2, passed: true });
  });

  it("does not forgive a miss when only two were asked", () => {
    const two = prompts.slice(0, 2);
    const { imu, flow } = head(two, { skip: [1] });
    expect(checkLiveness(flow, imu, two)).toMatchObject({ total: 2, matched: 1, passed: false });
  });

  it("never passes with fewer than two prompts, and survives empty or sparse data", () => {
    const one = prompts.slice(0, 1);
    const { imu, flow } = head(one);
    expect(checkLiveness(flow, imu, one)).toMatchObject({ matched: 1, passed: false });
    expect(checkLiveness([], [], prompts)).toMatchObject({ matched: 0, passed: false });
    expect(checkLiveness(flow, imu.slice(0, 5), prompts).passed).toBe(false);
    expect(checkLiveness(flow, imu, []).passed).toBe(false);
  });

  it("doesn't care which way the head turned, only about which way it moved", () => {
    const { imu, flow } = head(prompts);
    const mirrored = imu.map((s) => ({ ...s, rx: -s.rx, ry: -s.ry }));
    const flipped = flow.map((s) => ({ ...s, u: -s.u, v: -s.v }));
    expect(checkLiveness(flipped, mirrored, prompts).passed).toBe(true);
  });
});

describe("live check challenges", () => {
  it("issues random movements at random moments, never closer together than a movement lasts", () => {
    const c = new LivenessChallenges();
    const sequences = new Set<string>(); const firstTimes = new Set<number>();
    for (let i = 0; i < 80; i++) {
      const { prompts, nonce } = c.issue();
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(prompts).toHaveLength(PROMPT_COUNT);
      expect(prompts[0].at_ms).toBeGreaterThanOrEqual(1800); expect(prompts[0].at_ms).toBeLessThan(2600);
      prompts.forEach((p, j) => { if (j) expect(p.at_ms - prompts[j - 1].at_ms).toBeGreaterThanOrEqual(MIN_GAP_MS); });
      sequences.add(prompts.map((p) => p.axis).join(",")); firstTimes.add(prompts[0].at_ms);
    }
    expect(sequences.size).toBeGreaterThan(8); // many different sequences, not a couple of fixed ones
    expect(firstTimes.size).toBeGreaterThan(20); // and the timing varies too
  });

  it("takes back exactly what was issued, once", () => {
    const c = new LivenessChallenges();
    const { nonce, prompts } = c.issue();
    expect(c.consume(nonce, prompts)).toEqual(prompts);
    expect(() => c.consume(nonce, prompts)).toThrow(LivenessError); // spent
  });

  it("accepts a take that was stopped early, if at least two prompts were shown", () => {
    const c = new LivenessChallenges();
    const { nonce, prompts } = c.issue();
    expect(c.consume(nonce, prompts.slice(0, MIN_PROMPTS))).toEqual(prompts.slice(0, MIN_PROMPTS));
  });

  it("refuses a made-up, partial, reordered or oversized report, and still spends the nonce", () => {
    const c = new LivenessChallenges();
    const bad = (mutate: (p: ReturnType<LivenessChallenges["issue"]>) => unknown) => {
      const issued = c.issue();
      expect(() => c.consume(issued.nonce, mutate(issued))).toThrow(LivenessError);
      expect(() => c.consume(issued.nonce, issued.prompts)).toThrow(LivenessError); // the genuine one is now spent too
    };
    bad((i) => i.prompts.slice(0, 1));
    bad((i) => []);
    bad((i) => [...i.prompts, i.prompts[0]]);
    bad((i) => [i.prompts[1], i.prompts[0], i.prompts[2]]);
    bad((i) => [i.prompts[1], i.prompts[0], i.prompts[2]]);
    bad((i) => i.prompts.map((p) => ({ ...p, axis: p.axis === "yaw" ? "pitch" : "yaw" })));
    bad((i) => i.prompts.map((p) => ({ ...p, at_ms: p.at_ms + 1 })));
    bad(() => "yaw");
    bad(() => null);
    expect(() => c.consume("nope", [])).toThrow(LivenessError);
    expect(() => c.consume(undefined, undefined)).toThrow(LivenessError);
  });

  it("expires", () => {
    let t = 1_000_000;
    const c = new LivenessChallenges(() => t);
    const { nonce, prompts } = c.issue();
    t += 16 * 60_000;
    expect(() => c.consume(nonce, prompts)).toThrow(/expired/);
  });
});
