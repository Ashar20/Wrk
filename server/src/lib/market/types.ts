/**
 * Marketplace types.
 *
 * Follows product-spec §7 with two deliberate departures, both recorded in
 * docs/superpowers/specs/2026-08-23-contributor-pwa-design.md §10:
 *
 *  1. A framing threshold sits alongside the plausibility threshold. The spec
 *     only had the latter, but an authentic episode that never caught the
 *     hands is useless training data, and the two failures are unrelated.
 *  2. Plausibility carries an explicit MOTION POLICY. See below.
 */

/** Modalities a bounty can require. Mirrors product-spec §3.1. */
export type Modality = "rgb" | "imu" | "audio" | "gps" | "orientation";

export type TrustLevel = "self_reported" | "heuristic" | "attested" | "hardware";

/**
 * What to do when a capture has too little head motion to score plausibility.
 *
 * The flow-vs-gyro check needs the head to rotate. Seated desk tasks — typing
 * being the clearest case — barely move it: a real keyboard capture measured
 * 0.8 deg/s on device, well under the threshold where correlation means
 * anything. Requiring plausibility on such a bounty would reject every honest
 * submission, so the bounty states its position instead of the validator
 * guessing.
 *
 *   "require"      — an unscorable episode is rejected. For tasks with real
 *                    head movement, where a still capture is suspicious.
 *   "allow_static" — an unscorable episode is accepted and marked as carrying
 *                    no motion evidence. Honest for seated tasks, and weaker:
 *                    these episodes are the easiest in the network to fake.
 */
export type MotionPolicy = "require" | "allow_static";

/** Re-exported from the validator so the stored shape tracks what it emits. */
export type { ValidationResult } from "@/lib/validator/validate";

export interface Bounty {
  bounty_id: string;
  title: string;
  task_spec: string;
  /** Stable identifier for the task, used to group episodes. */
  task: string;
  required_modalities: Modality[];
  min_episodes: number;
  duration_range_s: [number, number];
  /** Minimum flow-vs-gyro correlation, 0–1. */
  min_plausibility: number;
  motion_policy: MotionPolicy;
  /** Minimum share of frames with hands usefully framed, 0–1. */
  min_framing: number;
  min_trust_level: TrustLevel;
  budget_usdc: number;
  per_episode_usdc: number;
  utility_pool_usdc: number;
  validator_fee_usdc: number;
  treasury_fee_usdc: number;
  license: string;
  deadline: number;
  created_at: number;
  status: "open" | "closed";
  /** Who posted it: a payment-account address, or "wrk" for the demo bounties. */
  owner?: string;
  /** "borderline": takes near the bar wait for a human reviewer before they are paid or refused. "always": every take that would otherwise be accepted does. */
  review_policy?: "none" | "borderline" | "always";
  /** "require": the contributor is prompted for random head movements, and the take must show them. */
  liveness?: "off" | "require";
  /** Where its money is locked. Absent when the validator runs without a chain (local development). */
  escrow?: { buyer: string; funded: boolean };
}

/** What a contributor submits after their episode is scored on-device. */
export interface EpisodeSubmission {
  episode_id: string;
  bounty_id: string;
  entity_id: string;
  manifest_hash: string;
  duration_s: number;
  /** Null when the capture had too little motion to judge. */
  plausibility: number | null;
  framing: number | null;
  trust_level: TrustLevel;
  ua_class: string;
  recorded_at: number;
  /** Perceptual signature, sealed in the manifest, for duplicate detection. */
  signature?: string[];
  /**
   * Diagnostics the server can read without anyone reciting numbers off a
   * phone. `framing` alone cannot distinguish hands that were never
   * detected from hands detected in the wrong coordinate space — both read
   * as 0%, and the fixes are entirely different.
   */
  hands_visible_percent?: number | null;
  detections?: number;
  analysis_errors?: number;
  analysis_error?: string | null;
}

/**
 * Scoring takes over a minute on a real episode, so an upload cannot wait on
 * it. An episode arrives `scoring`, and becomes `scored` when the validator
 * has finished and the acceptance decision has been made.
 */
export type EpisodeStatus = "scoring" | "scored" | "failed";

export interface StoredEpisode extends EpisodeSubmission {
  status: EpisodeStatus;
  /** Why scoring failed, when it did. */
  scoring_error?: string | null;
  accepted: boolean;
  reasons: string[];
  /** Set when accepted, from the bounty's per-episode rate. */
  paid_usdc: number;
  received_at: number;
  /** What the server independently verified, rather than what the client said. */
  validation?: import("@/lib/validator/validate").ValidationResult;
  /** Where the verified bytes landed. Empty when none were uploaded. */
  streams?: Array<{
    kind: string;
    uri: string;
    bytes: number;
    /** Content address — the same bytes give this on any IPFS node. */
    cid?: string;
    /** Whether an IPFS node was asked to hold them. Not a durability claim. */
    pinned?: boolean;
    content_type?: string;
  }>;
  /**
   * The on-chain commitment, when one was made.
   *
   * Absent is normal and not a failure: anchoring runs after an episode is
   * already scored and stored, so a flaky RPC costs a transaction hash rather
   * than an episode. product-spec §6.1's claim is about what the chain proves
   * once the hash is there, not about the chain being on the critical path.
   */
  anchor?: EpisodeAnchor;
  /**
   * The on-chain USDC release, when it happened.
   *
   * Independent of `accepted`: an episode is accepted by the validator's
   * findings against the bounty's thresholds, and that verdict does not become
   * provisional because an RPC was unreachable.
   */
  payment?: EpisodePayment;
}

/** The token release for an accepted episode. */
export interface EpisodePayment {
  cluster: string;
  contributor: string;
  amount_usdc: number;
  /** Solana transaction signature of the payout. */
  signature: string;
  paid_at: number;
  /** Set when the release was attempted and failed; the episode still stands. */
  error?: string;
}

export interface EpisodeAnchor {
  cluster: string;
  contributor: string;
  /** Solana signature of the memo transaction the contributor sent. */
  signature: string;
  /** Whether the server confirmed the memo on chain and matched its text. */
  verified: boolean;
  anchored_at: number;
  error?: string;
}

/**
 * A bounty's money must add up.
 *
 * product-spec §7's example bounty spends its whole budget on per-episode
 * payments plus the utility pool, leaving nothing for the validator and
 * treasury that §13 allocates 5% each. One of the two is wrong; this makes the
 * inconsistency impossible to commit.
 */

export function budgetBreakdown(bounty: Bounty): {
  episodes: number;
  allocated: number;
  balanced: boolean;
} {
  const episodes = bounty.per_episode_usdc * bounty.min_episodes;
  const allocated =
    episodes + bounty.utility_pool_usdc + bounty.validator_fee_usdc + bounty.treasury_fee_usdc;

  // Float arithmetic on currency; compare to the cent.
  return {
    episodes,
    allocated,
    balanced: Math.abs(allocated - bounty.budget_usdc) < 0.005,
  };
}

/**
 * Strips a bounty's acceptance thresholds before it leaves the server, so a
 * contributor cannot tailor a submission to just clear the bar.
 */
export function redactThresholds(bounty: Bounty): Omit<Bounty, "min_plausibility" | "min_framing"> {
  const rest: Partial<Bounty> = { ...bounty };
  delete rest.min_plausibility;
  delete rest.min_framing;
  return rest as Omit<Bounty, "min_plausibility" | "min_framing">;
}
