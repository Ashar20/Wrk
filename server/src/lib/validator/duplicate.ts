/**
 * Near-duplicate detection across episodes.
 *
 * The economic failure mode this defends against: at a flat per-episode rate,
 * a contributor can record the same fifteen seconds repeatedly and farm a
 * bounty in half an hour. Every submission is byte-distinct, so cryptographic
 * hashing sees nothing wrong; the buyer gets a hundred copies of one scene.
 *
 * Comparison is between episode SIGNATURES — several frames spread across each
 * episode — rather than single frames, because two honest takes of the same
 * task usually share an opening frame and differ in what happens after.
 */

import { episodeSignature, similarity } from "./phash";

export interface EpisodeFingerprint {
  episode_id: string;
  entity_id: string;
  /** Perceptual hashes sampled across the episode. */
  signature: string[];
}

export interface DuplicateMatch {
  episode_id: string;
  /** Mean similarity across matched frames, 0–1. */
  similarity: number;
  sameEntity: boolean;
}

export interface DuplicateOptions {
  /** Mean similarity at or above which two episodes are the same content. */
  threshold?: number;
  /** Only compare against the same contributor's prior work. */
  sameEntityOnly?: boolean;
}

const DEFAULTS = { threshold: 0.9, sameEntityOnly: false } as const;

/**
 * Mean best-match similarity between two signatures.
 *
 * Each frame of the candidate is matched against its most similar counterpart
 * in the prior episode, so a duplicate recorded at a slightly different offset
 * still scores high — the frames are the same, just shifted in time.
 */
export function signatureSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  let total = 0;
  for (const hash of a) {
    let best = 0;
    for (const other of b) {
      const score = similarity(hash, other);
      if (score > best) best = score;
    }
    total += best;
  }
  return total / a.length;
}

/** Prior episodes whose content matches the candidate. */
export function findDuplicates(
  candidate: EpisodeFingerprint,
  prior: readonly EpisodeFingerprint[],
  options: DuplicateOptions = {},
): DuplicateMatch[] {
  const { threshold, sameEntityOnly } = { ...DEFAULTS, ...options };
  const signature = episodeSignature(candidate.signature);

  const matches: DuplicateMatch[] = [];
  for (const other of prior) {
    if (other.episode_id === candidate.episode_id) continue;

    const sameEntity = other.entity_id === candidate.entity_id;
    if (sameEntityOnly && !sameEntity) continue;

    const score = signatureSimilarity(signature, episodeSignature(other.signature));
    if (score >= threshold) {
      matches.push({ episode_id: other.episode_id, similarity: score, sameEntity });
    }
  }

  // Closest first, so a reason can name the most convincing match.
  return matches.sort((x, y) => y.similarity - x.similarity);
}
