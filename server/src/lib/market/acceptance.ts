/**
 * Whether a submitted episode satisfies its bounty.
 *
 * Pure and total: every rejection carries a reason the contributor can read
 * and act on. "Rejected" with no explanation is the fastest way to lose a
 * supply side that has no obligation to keep contributing.
 */

import type { Bounty, EpisodeSubmission, TrustLevel } from "./types";

export interface Decision {
  accepted: boolean;
  reasons: string[];
  /** Payment owed on acceptance, from the bounty's flat per-episode rate. */
  paid_usdc: number;
}

const TRUST_ORDER: Record<TrustLevel, number> = {
  self_reported: 0,
  heuristic: 1,
  attested: 2,
  hardware: 3,
};

export function meetsTrustLevel(actual: TrustLevel, required: TrustLevel): boolean {
  return TRUST_ORDER[actual] >= TRUST_ORDER[required];
}

export function evaluateEpisode(bounty: Bounty, episode: EpisodeSubmission): Decision {
  const reasons: string[] = [];

  if (bounty.status !== "open") {
    reasons.push("This bounty is closed.");
  }

  if (episode.recorded_at > bounty.deadline) {
    reasons.push("Recorded after the bounty deadline.");
  }

  const [minS, maxS] = bounty.duration_range_s;
  if (episode.duration_s < minS) {
    reasons.push(`Episode is ${episode.duration_s.toFixed(1)}s; the bounty needs at least ${minS}s.`);
  }
  if (episode.duration_s > maxS) {
    reasons.push(`Episode is ${episode.duration_s.toFixed(1)}s; the bounty allows at most ${maxS}s.`);
  }

  if (!meetsTrustLevel(episode.trust_level, bounty.min_trust_level)) {
    reasons.push(
      `Trust level "${episode.trust_level}" is below the required "${bounty.min_trust_level}".`,
    );
  }

  if (bounty.min_framing <= 0) {
    // Hand framing is optional for this bounty; nothing to check.
  } else if (episode.framing === null) {
    reasons.push("Framing could not be measured; no frames were analysed.");
  } else if (episode.framing < bounty.min_framing) {
    // Says the check failed, not by how much, so the bar cannot be triangulated.
    reasons.push("Hands were not well framed enough for this bounty's requirement.");
  }

  if (episode.plausibility === null) {
    // Not a silent pass. A seated task genuinely cannot produce this evidence,
    // and the bounty decides whether that is acceptable — but the episode is
    // still marked as carrying none.
    if (bounty.motion_policy === "require") {
      reasons.push(
        "Too little head motion to verify the capture against the gyroscope, " +
          "and this bounty requires that check.",
      );
    }
  } else if (episode.plausibility < bounty.min_plausibility) {
    reasons.push("Motion match was too low for this bounty's requirement.");
  }

  const accepted = reasons.length === 0;
  return { accepted, reasons, paid_usdc: accepted ? bounty.per_episode_usdc : 0 };
}

/** True when an accepted episode carries no motion evidence at all. */
export function lacksMotionEvidence(bounty: Bounty, episode: EpisodeSubmission): boolean {
  return episode.plausibility === null && bounty.motion_policy === "allow_static";
}
