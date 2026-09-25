import { describe, expect, it } from "vitest";
import {
  framingScore,
  GUIDE_REGION,
  handInsideFraction,
  isInside,
  type FrameHands,
  type Landmark,
} from "./framing";

/** A 21-point hand centred on (cx, cy) with a realistic spread. */
function hand(cx: number, cy: number, spread = 0.06): Landmark[] {
  return Array.from({ length: 21 }, (_, i) => {
    const angle = (i / 21) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * spread, y: cy + Math.sin(angle) * spread };
  });
}

function frames(specs: Array<Landmark[][]>): FrameHands[] {
  return specs.map((hands, i) => ({ t: i * 125, hands }));
}

const INSIDE = { x: 0.5, y: 0.65 };
const ABOVE = { x: 0.5, y: 0.1 };

describe("isInside", () => {
  it("accepts a point within the guide", () => {
    expect(isInside(INSIDE, GUIDE_REGION)).toBe(true);
  });

  it("rejects a point above the guide, where a head-mounted camera looks", () => {
    expect(isInside(ABOVE, GUIDE_REGION)).toBe(false);
  });

  it("treats the boundary as inside", () => {
    expect(isInside({ x: GUIDE_REGION.x0, y: GUIDE_REGION.y0 }, GUIDE_REGION)).toBe(true);
  });
});

describe("handInsideFraction", () => {
  it("is 1 for a fully contained hand", () => {
    expect(handInsideFraction(hand(0.5, 0.65), GUIDE_REGION)).toBe(1);
  });

  it("is 0 for a hand entirely outside", () => {
    expect(handInsideFraction(hand(0.5, 0.08, 0.02), GUIDE_REGION)).toBe(0);
  });

  it("is partial for a hand straddling the boundary", () => {
    const fraction = handInsideFraction(hand(0.5, GUIDE_REGION.y0, 0.06), GUIDE_REGION);
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);
  });

  it("is 0 for an empty landmark list rather than dividing by zero", () => {
    expect(handInsideFraction([], GUIDE_REGION)).toBe(0);
  });
});

describe("framingScore", () => {
  it("scores a well-framed capture at 100%", () => {
    const report = framingScore(frames(Array.from({ length: 20 }, () => [hand(0.5, 0.65)])));

    expect(report.verdict).toBe("ok");
    expect(report.percent).toBe(100);
    expect(report.visibilityPercent).toBe(100);
  });

  it("scores a capture where hands are never visible at 0%", () => {
    const report = framingScore(frames(Array.from({ length: 20 }, () => [])));

    expect(report.percent).toBe(0);
    expect(report.visibilityPercent).toBe(0);
    expect(report.framesWithHands).toBe(0);
  });

  it("separates 'hand visible' from 'hand usefully framed'", () => {
    // The exact FOV failure this exists to catch: hands are detected, but they
    // sit at the top of frame where a head-mounted phone points, not in the
    // region the task needs.
    const report = framingScore(frames(Array.from({ length: 10 }, () => [hand(0.5, 0.12, 0.03)])));

    expect(report.visibilityPercent).toBe(100);
    expect(report.percent).toBe(0);
  });

  it("reports the partial rate when hands drift out mid-episode", () => {
    const good = Array.from({ length: 6 }, () => [hand(0.5, 0.65)]);
    const drifted = Array.from({ length: 4 }, () => [hand(0.5, 0.1, 0.03)]);
    const report = framingScore(frames([...good, ...drifted]));

    expect(report.percent).toBe(60);
    expect(report.framesInGuide).toBe(6);
  });

  it("counts a frame when either hand is well framed, since tasks are often one-handed", () => {
    const report = framingScore(frames([[hand(0.5, 0.1, 0.03), hand(0.5, 0.65)]]));
    expect(report.percent).toBe(100);
  });

  it("tolerates fingers crossing the boundary during a grasp", () => {
    // A hand mostly inside with a few landmarks over the line is well framed.
    const straddling = hand(0.5, GUIDE_REGION.y1 - 0.03, 0.05);
    const report = framingScore(frames([[straddling]]));

    expect(handInsideFraction(straddling, GUIDE_REGION)).toBeLessThan(1);
    expect(report.percent).toBe(100);
  });

  it("respects a custom guide region", () => {
    const wholeFrame = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const report = framingScore(frames([[hand(0.5, 0.1, 0.03)]]), { guide: wholeFrame });

    expect(report.percent).toBe(100);
  });

  it("returns no_frames rather than a score when nothing was analysed", () => {
    const report = framingScore([]);
    expect(report.verdict).toBe("no_frames");
    expect(report.percent).toBeNull();
  });
});
