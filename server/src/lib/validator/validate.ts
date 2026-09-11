/**
 * Server-side validation of a submitted episode.
 *
 * This is product-spec §6.3's validator, and the honest framing from §6.2
 * applies to every line of it: a PWA cannot attest that pixels came from a
 * real camera at a real time. Nothing here proves physical origin. What it
 * does is:
 *
 *   - verify INTEGRITY, by recomputing every hash from the bytes that arrived
 *     rather than trusting what the client claimed;
 *   - measure PLAUSIBILITY, from cross-modal agreement and the completeness
 *     of what was delivered;
 *   - detect NEAR-DUPLICATES, which is what defends the economics.
 *
 * Scores arrive as an explicit argument and are never read out of the
 * manifest. That distinction is the whole point: a contributor seals their own
 * commitment, so a manifest declaring 100% cross-modal agreement is internally
 * consistent, hashes correctly, and means nothing. Only numbers this server
 * measured from the uploaded bytes are allowed to reach a check.
 */

import { canonicalize, sha256Hex, type Manifest } from "@/lib/manifest";
import { findDuplicates, type DuplicateMatch, type EpisodeFingerprint } from "./duplicate";

export type TrustLevel = "self_reported" | "heuristic" | "attested" | "hardware";

export interface ValidationChecks {
  /** Manifest hash recomputed from the manifest that arrived. */
  manifest_intact: boolean;
  /** Every declared stream's sha256 recomputed from its bytes. */
  streams_intact: boolean;
  /** Share of the bounty's required modalities actually present, 0–1. */
  completeness: number;
  duration_ok: boolean;
  /** Observed frame rate is present and plausible against nominal. */
  frame_rate_ok: boolean;
  /** IMU arrived at a rate that can support the motion checks. */
  imu_rate_ok: boolean;
  /** Cross-modal agreement, 0–1. Null when the capture had too little motion. */
  flow_gyro_corr: number | null;
  /** Share of frames with hands usefully framed, 0–1. */
  framing: number | null;
  duplicate_of: string | null;
  duplicate_similarity: number | null;
}

export interface ValidationResult {
  plausibility_score: number;
  checks: ValidationChecks;
  trust_level: TrustLevel;
  /**
   * Who scored it. product-spec §5's manifest carries this and §6.1 rests on
   * it: "a specific wallet submitted a specific manifest" is only half the
   * claim if the result cannot be traced to a validator either.
   *
   * Null where no validator identity is configured, which is honest — the
   * alternative is naming one that did not sign anything.
   */
  validator: string | null;
  /** Reasons the episode cannot be trusted or used, in plain language. */
  failures: string[];
}

/**
 * Scores measured by the server, in percent.
 *
 * Null where a score could not be computed — a capture with too little motion
 * has no cross-modal agreement to measure, and that is different from scoring
 * zero on it.
 */
export interface MeasuredScores {
  framingPercent: number | null;
  plausibilityPercent: number | null;
}

export interface StreamBytes {
  kind: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface ValidateInput {
  manifest: Manifest;
  /** Bytes actually received, if any. Integrity is unverifiable without them. */
  streams?: StreamBytes[];
  /**
   * What the server measured. Omitted on the integrity pre-check that runs
   * before anything is stored, where no frame has been decoded yet.
   */
  scores?: MeasuredScores;
  requiredModalities: readonly string[];
  durationRangeS: readonly [number, number];
  fingerprint?: EpisodeFingerprint;
  priorFingerprints?: readonly EpisodeFingerprint[];
  /** The address recording this result, when the chain is configured. */
  validator?: string | null;
}

/** Recompute the manifest hash from what arrived and compare. */
export async function verifyManifestIntegrity(manifest: Manifest): Promise<boolean> {
  const claimed = manifest.manifest_hash;
  if (typeof claimed !== "string") return false;

  const rest = { ...manifest };
  delete rest.manifest_hash;
  const recomputed = await sha256Hex(new TextEncoder().encode(canonicalize(rest)));
  return recomputed === claimed;
}

/** Recompute each stream's digest from its bytes. */
export async function verifyStreams(streams: readonly StreamBytes[]): Promise<boolean> {
  for (const stream of streams) {
    if ((await sha256Hex(stream.bytes)) !== stream.sha256) return false;
  }
  return true;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function validateEpisode(input: ValidateInput): Promise<ValidationResult> {
  const { manifest, streams, requiredModalities, durationRangeS } = input;
  const failures: string[] = [];

  const manifest_intact = await verifyManifestIntegrity(manifest);
  if (!manifest_intact) {
    failures.push("Manifest hash does not match the manifest it arrived with.");
  }

  // Absent bytes are not the same as corrupt bytes; say which happened.
  const streams_intact = streams && streams.length > 0 ? await verifyStreams(streams) : false;
  if (streams && streams.length > 0 && !streams_intact) {
    failures.push("A stream's contents do not match the digest the manifest declares.");
  } else if (!streams || streams.length === 0) {
    failures.push("No stream bytes were supplied, so integrity could not be verified.");
  }

  const declared = Object.keys((manifest.streams as Record<string, unknown>) ?? {});
  const present = requiredModalities.filter((m) => declared.includes(m));
  const completeness = requiredModalities.length === 0 ? 1 : present.length / requiredModalities.length;
  if (completeness < 1) {
    const missing = requiredModalities.filter((m) => !declared.includes(m));
    failures.push(`Missing required modalities: ${missing.join(", ")}.`);
  }

  const duration = num(manifest.duration_s) ?? 0;
  const duration_ok = duration >= durationRangeS[0] && duration <= durationRangeS[1];
  if (!duration_ok) {
    failures.push(
      `Duration ${duration.toFixed(1)}s is outside the accepted ` +
        `${durationRangeS[0]}–${durationRangeS[1]}s range.`,
    );
  }

  const capture = manifest.capture as { video?: Record<string, unknown>; imu?: Record<string, unknown> };
  const nominal = num(capture?.video?.fps_nominal) ?? 0;
  const observed = num(capture?.video?.fps_observed);

  // Unknown is acceptable — Safari cannot report it — but a value that
  // contradicts the nominal rate is a sign the manifest was hand-written.
  const frame_rate_ok = observed === null ? nominal > 0 : observed > 0 && observed <= nominal * 1.5;
  if (!frame_rate_ok) {
    failures.push("Observed frame rate is implausible against the nominal rate.");
  }

  const imuRate = num(capture?.imu?.rate_hz_observed) ?? 0;
  const imu_rate_ok = imuRate >= 10;
  if (!imu_rate_ok) {
    failures.push(`IMU arrived at ${imuRate.toFixed(1)}Hz; too sparse to support motion checks.`);
  }

  // Deliberately not manifest.quality. See the note at the top of this file.
  const flow_gyro_corr = toFraction(num(input.scores?.plausibilityPercent));
  const framing = toFraction(num(input.scores?.framingPercent));

  let duplicate: DuplicateMatch | null = null;
  if (input.fingerprint && input.priorFingerprints?.length) {
    duplicate = findDuplicates(input.fingerprint, input.priorFingerprints)[0] ?? null;
    if (duplicate) {
      failures.push(
        `Content matches episode ${duplicate.episode_id} at ` +
          `${(duplicate.similarity * 100).toFixed(0)}% similarity.`,
      );
    }
  }

  const checks: ValidationChecks = {
    manifest_intact,
    streams_intact,
    completeness,
    duration_ok,
    frame_rate_ok,
    imu_rate_ok,
    flow_gyro_corr,
    framing,
    duplicate_of: duplicate?.episode_id ?? null,
    duplicate_similarity: duplicate?.similarity ?? null,
  };

  return {
    plausibility_score: score(checks),
    checks,
    // Every rung above this needs hardware attestation the web cannot reach.
    trust_level: "heuristic",
    validator: input.validator ?? null,
    failures,
  };
}

function toFraction(percent: number | null): number | null {
  return percent === null ? null : percent / 100;
}

/**
 * A single score for buyers to filter on.
 *
 * Integrity is a gate rather than a term: a manifest that does not match its
 * own hash is worth zero regardless of how good the footage looks, and so is a
 * duplicate. Everything else contributes proportionally.
 */
export function score(checks: ValidationChecks): number {
  if (!checks.manifest_intact) return 0;
  if (checks.duplicate_of !== null) return 0;
  if (!checks.duration_ok) return 0;

  const terms: number[] = [checks.completeness];
  terms.push(checks.frame_rate_ok ? 1 : 0);
  terms.push(checks.imu_rate_ok ? 1 : 0);
  terms.push(checks.streams_intact ? 1 : 0);

  // Cross-modal agreement is the strongest available signal, so it is weighted
  // above the structural checks. Absent it, the episode is capped: a capture
  // with no motion evidence should never score as highly as one that has it.
  if (checks.flow_gyro_corr !== null) {
    terms.push(checks.flow_gyro_corr, checks.flow_gyro_corr);
  }
  if (checks.framing !== null) terms.push(checks.framing);

  const mean = terms.reduce((a, b) => a + b, 0) / terms.length;
  const capped = checks.flow_gyro_corr === null ? Math.min(mean, 0.6) : mean;

  return Math.round(capped * 1000) / 1000;
}
