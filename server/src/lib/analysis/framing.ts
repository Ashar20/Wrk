/**
 * Framing quality from hand landmarks.
 *
 * A phone rear camera sees roughly 65-70 degrees against the 110-150 of the
 * rigs Ego4D and Aria used. Head-mounted at that field of view, manipulation
 * at chest or waist level leaves frame constantly — and product-spec §3.2 does
 * not mention it. The framing box in the viewfinder was a guess; this measures
 * whether the hands were actually where the task needs them.
 *
 * The guide region is defined HERE and consumed by both the overlay and the
 * scorer, so the box a contributor aims at is the box they are scored against.
 */

/** Normalised region, origin top-left, in [0,1] of frame width and height. */
export interface GuideRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Default usable region.
 *
 * Biased toward the lower frame because a head-mounted camera points where the
 * head points, while the hands work below that line. Provisional until enough
 * real strap-on captures exist to place it from data.
 */
export const GUIDE_REGION: GuideRegion = { x0: 0.12, y0: 0.38, x1: 0.88, y1: 0.92 };

/** One landmark. MediaPipe returns normalised coordinates. */
export interface Landmark {
  x: number;
  y: number;
}

/** Hands detected in a single sampled frame. */
export interface FrameHands {
  t: number;
  hands: Landmark[][];
}

export type FramingVerdict = "ok" | "no_frames";

export interface FramingReport {
  verdict: FramingVerdict;
  /** Share of analysed frames with a hand usefully inside the guide, 0–100. */
  percent: number | null;
  framesAnalyzed: number;
  framesWithHands: number;
  framesInGuide: number;
  /** Share of frames where a hand was visible at all, 0–100. */
  visibilityPercent: number | null;
}

export interface FramingOptions {
  guide?: GuideRegion;
  /**
   * Fraction of a hand's landmarks that must fall inside the guide for the
   * frame to count. Below 1 because fingers routinely cross the boundary
   * during a grasp without the hand being badly framed.
   */
  minLandmarksInside?: number;
}

const DEFAULTS = { guide: GUIDE_REGION, minLandmarksInside: 0.7 } as const;

export function isInside(point: Landmark, guide: GuideRegion): boolean {
  return point.x >= guide.x0 && point.x <= guide.x1 && point.y >= guide.y0 && point.y <= guide.y1;
}

/** Fraction of a hand's landmarks inside the guide, 0–1. */
export function handInsideFraction(hand: readonly Landmark[], guide: GuideRegion): number {
  if (hand.length === 0) return 0;
  let inside = 0;
  for (const point of hand) if (isInside(point, guide)) inside++;
  return inside / hand.length;
}

export function framingScore(
  frames: readonly FrameHands[],
  options: FramingOptions = {},
): FramingReport {
  const { guide, minLandmarksInside } = { ...DEFAULTS, ...options };

  if (frames.length === 0) {
    return {
      verdict: "no_frames",
      percent: null,
      framesAnalyzed: 0,
      framesWithHands: 0,
      framesInGuide: 0,
      visibilityPercent: null,
    };
  }

  let withHands = 0;
  let inGuide = 0;

  for (const frame of frames) {
    const visible = frame.hands.filter((hand) => hand.length > 0);
    if (visible.length === 0) continue;
    withHands++;

    // One well-framed hand is enough — many tasks are single-handed, and
    // requiring both would fail them.
    const best = Math.max(...visible.map((hand) => handInsideFraction(hand, guide)));
    if (best >= minLandmarksInside) inGuide++;
  }

  const pct = (n: number) => Math.round((n / frames.length) * 1000) / 10;

  return {
    verdict: "ok",
    percent: pct(inGuide),
    framesAnalyzed: frames.length,
    framesWithHands: withHands,
    framesInGuide: inGuide,
    visibilityPercent: pct(withHands),
  };
}
