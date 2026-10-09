import type { Store, EpisodeRecord } from "./store";
import type { Bounty } from "@/lib/market/types";

const cents = (n: number) => Math.round(n * 100) / 100;

/** Demo bounties belong to Wrk and are visible to every buyer; anything else only to the buyer who posted it. */
export const visibleToBuyer = (b: Bounty, buyer: string) => b.owner === "wrk" || b.owner === buyer;

export function bountyStats(episodes: EpisodeRecord[], bounty: Bounty) {
  const mine = episodes.filter((e) => e.bounty_id === bounty.bounty_id);
  const accepted = mine.filter((e) => e.status === "scored" && e.accepted);
  const scored = mine.filter((e) => e.plausibility !== null && e.plausibility !== undefined);
  const histogram = [0, 0, 0, 0, 0]; // 0–20, 20–40, 40–60, 60–80, 80–100 %
  for (const e of scored) histogram[Math.min(4, Math.floor((e.plausibility as number) * 5))]++;
  return {
    accepted: accepted.length,
    rejected: mine.filter((e) => e.status === "scored" && !e.accepted).length + mine.filter((e) => e.status === "failed").length,
    in_review: mine.filter((e) => e.status === "in_review").length,
    scoring: mine.filter((e) => e.status === "scoring").length,
    spend_usdc: cents(accepted.reduce((n, e) => n + (e.payment && !e.payment.error ? e.payment.amount_usdc : 0), 0)),
    avg_plausibility: scored.length ? cents(scored.reduce((n, e) => n + (e.plausibility as number), 0) / scored.length) : null,
    histogram,
  };
}

export function summary(episodes: EpisodeRecord[], bounties: Bounty[], buyer: string) {
  const rows = bounties.filter((b) => visibleToBuyer(b, buyer)).map((b) => ({
    bounty_id: b.bounty_id,
    title: b.title,
    status: b.status,
    owner_is_you: b.owner === buyer,
    per_episode_usdc: b.per_episode_usdc,
    min_episodes: b.min_episodes,
    budget_usdc: b.budget_usdc,
    review_policy: b.review_policy ?? "none",
    liveness: b.liveness ?? "off",
    min_trust_level: b.min_trust_level,
    ...bountyStats(episodes, b),
  }));
  return { total_spend_usdc: cents(rows.reduce((n, r) => n + r.spend_usdc, 0)), bounties: rows };
}

/** What a buyer downloads: the accepted takes' provenance and scores. No raw media, no thresholds. */
export function dataset(episodes: EpisodeRecord[], bounty: Bounty) {
  const accepted = episodes.filter((e) => e.bounty_id === bounty.bounty_id && e.status === "scored" && e.accepted);
  return {
    bounty_id: bounty.bounty_id,
    title: bounty.title,
    task: bounty.task,
    license: bounty.license,
    generated_at: Math.floor(Date.now() / 1000),
    trust_level: "heuristic",
    episode_count: accepted.length,
    episodes: accepted.map((e) => ({
      episode_id: e.episode_id,
      manifest_hash: e.manifest_hash,
      duration_s: e.duration_s,
      recorded_at: e.recorded_at,
      contributor: e.contributor,
      plausibility: e.plausibility,
      framing: e.framing ?? null,
      human_reviewed: e.review?.status === "approved",
      trust_level: e.trust_level ?? "heuristic",
      anchor_signature: e.anchor?.signature ?? null,
      payment_signature: e.payment?.signature ?? null,
    })),
  };
}
