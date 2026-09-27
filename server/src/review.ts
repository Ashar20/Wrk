import { payOnce, type PipelineDeps } from "./pipeline";
import type { EpisodeRecord } from "./store";
import type { Bounty } from "@/lib/market/types";

/** What a verifier earns per decision, from the bounty's validator pool. Approve or reject pays the same. */
export const REVIEW_FEE_USDC = 0.05;

export class ReviewError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface Reviewer {
  address: string;
}

export function queueItem(e: EpisodeRecord, bounty: Bounty) {
  return {
    episode_id: e.episode_id,
    bounty_id: e.bounty_id,
    bounty_title: bounty.title,
    task_spec: bounty.task_spec,
    duration_s: e.duration_s,
    plausibility: e.plausibility,
    framing: e.framing ?? null,
    hands_visible_percent: e.hands_visible_percent ?? null,
    flow_gyro_corr: e.validation?.checks.flow_gyro_corr ?? null,
    per_episode_usdc: bounty.per_episode_usdc,
    fee_usdc: REVIEW_FEE_USDC,
    received_at: e.received_at,
  };
}

/** Takes waiting for a person. Never your own, and nothing already decided. */
export function pendingFor(all: EpisodeRecord[], bountyOf: (id: string) => Bounty | undefined, reviewer: Reviewer) {
  return all
    .filter((e) => e.status === "in_review" && e.review?.status === "pending" && e.contributor !== reviewer.address)
    .sort((a, b) => a.received_at - b.received_at)
    .flatMap((e) => {
      const b = bountyOf(e.bounty_id);
      return b ? [queueItem(e, b)] : [];
    });
}

export function historyFor(all: EpisodeRecord[], bountyOf: (id: string) => Bounty | undefined, reviewer: Reviewer) {
  const mine = all.filter((e) => e.review?.reviewer === reviewer.address && e.review.status !== "pending")
    .sort((a, b) => (b.review!.decided_at ?? 0) - (a.review!.decided_at ?? 0));
  const items = mine.map((e) => ({
    episode_id: e.episode_id,
    bounty_title: bountyOf(e.bounty_id)?.title ?? e.bounty_id,
    decision: e.review!.status as "approved" | "rejected",
    decided_at: e.review!.decided_at ?? 0,
    fee_usdc: e.review!.fee && !e.review!.fee.error ? e.review!.fee.amount_usdc : 0,
    fee_signature: e.review!.fee?.signature ?? null,
  }));
  return { earned_usdc: Math.round(items.reduce((n, i) => n + i.fee_usdc, 0) * 100) / 100, items };
}

const deciding = new Set<string>();

/** One decision per take, first one wins. Approval pays the contributor; either way the reviewer is paid. */
export async function decide(
  deps: PipelineDeps,
  id: string,
  reviewer: Reviewer,
  decision: "approve" | "reject",
  note: string,
  bounty: Bounty,
) {
  const { store, chain } = deps;
  const e = store.get(id);
  if (!e || e.status !== "in_review" || e.review?.status !== "pending") throw new ReviewError("This take has already been reviewed.", 409);
  if (e.contributor === reviewer.address) throw new ReviewError("You can't review your own take.", 403);
  if (deciding.has(id)) throw new ReviewError("This take has already been reviewed.", 409);
  deciding.add(id);
  try {
    const approved = decision === "approve";
    store.update(id, {
      status: "scored",
      accepted: approved,
      reasons: approved ? [] : ["A reviewer checked this take and didn't find it genuine."],
      review: { ...e.review!, status: approved ? "approved" : "rejected", reviewer: reviewer.address, decided_at: Math.floor(Date.now() / 1000), note: note.slice(0, 280) },
    });

    if (approved && chain && e.contributor) await payOnce(deps, id, e.contributor, bounty.per_episode_usdc);

    if (chain) {
      try {
        const signature = await chain.pay({ contributor: reviewer.address, amountUsdc: REVIEW_FEE_USDC, episodeId: `${id}:review` });
        store.update(id, { review: { ...store.get(id)!.review!, fee: { amount_usdc: REVIEW_FEE_USDC, signature } } });
      } catch (err) {
        store.update(id, { review: { ...store.get(id)!.review!, fee: { amount_usdc: REVIEW_FEE_USDC, error: err instanceof Error ? err.message : String(err) } } });
      }
    }
  } finally {
    deciding.delete(id);
  }
  return store.get(id)!;
}
