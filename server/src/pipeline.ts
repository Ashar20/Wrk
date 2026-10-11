import { evaluateEpisode } from "@/lib/market/acceptance";
import type { Bounty, EpisodeSubmission } from "@/lib/market/types";
import type { Manifest } from "@/lib/manifest";
import type { EpisodeFingerprint } from "@/lib/validator/duplicate";
import { validateEpisode, type StreamBytes } from "@/lib/validator/validate";
import type { ScoreOptions, Scores } from "@/lib/validator/score";
import type { ChainPort, EscrowRef } from "./solana/chain";
import type { EpisodeRecord, Store } from "./store";

export type ScoreFn = (video: Uint8Array, imu: Uint8Array, options?: ScoreOptions) => Promise<Scores>;

export interface PipelineDeps {
  store: Store;
  chain: ChainPort | null;
  score: ScoreFn;
  /** When true an episode is only accepted once it is recorded in its task's escrow. */
  requireAnchor: boolean;
  validatorId?: string | null;
  /** Called after a payout lands, so a bounty that has met its quota can close. */
  onPaid?: (bountyId: string) => void;
  /** Called once a take is finally accepted or refused, so its device builds (or loses) standing. */
  onDecided?: (episodeId: string, accepted: boolean) => void;
}

/** Takes this close to a bounty's bar are worth a human look when the bounty asks for one. */
export const REVIEW_BAND = 0.15;

const settling = new Set<string>();

/** The task's escrow, or null when the validator runs without a chain. */
export const escrowRef = (b: Bounty): EscrowRef | null => (b.escrow ? { buyer: b.escrow.buyer, bountyId: b.bounty_id } : null);

const scoreBps = (p: number | null | undefined) => Math.max(0, Math.min(10_000, Math.round((p ?? 0) * 10_000)));

const LIVENESS_FAILED = "The live head-movement check didn't match the video, so it can't be paid.";
const NOT_FOUND = "The submission was not found on Solana, so it cannot be paid.";

/**
 * Score, validate, decide, and (only for accepted + anchored episodes) pay.
 * Every failure is written onto the episode so nothing sits in "scoring" forever,
 * and a payout can only ever happen once per episode.
 */
export async function runPipeline(
  deps: PipelineDeps,
  args: {
    episodeId: string;
    bounty: Bounty;
    manifest: Manifest;
    streams: StreamBytes[];
    anchorSignature: string | null;
    /** Set for email accounts: the server records the take on-chain for them. */
    custodialSecret?: Uint8Array | null;
    /** Set for wallet accounts that signed in: the address the validator may record this take for. */
    relayFor?: string | null;
  },
): Promise<void> {
  const { store, chain } = deps;
  const { episodeId, bounty, manifest, streams, custodialSecret, relayFor } = args;
  let anchorSignature = args.anchorSignature;
  try {
    const video = streams.find((s) => s.kind === "rgb");
    const imu = streams.find((s) => s.kind === "imu");
    if (!video) throw new Error("No video stream was uploaded, so nothing can be scored.");

    const rec = store.get(episodeId)!;
    const scores = await deps.score(video.bytes, imu?.bytes ?? new Uint8Array(), { prompts: rec.liveness_prompts });

    const prior: EpisodeFingerprint[] = store
      .list()
      .filter((e) => e.episode_id !== episodeId && e.signature.length > 0)
      .map((e) => ({ episode_id: e.episode_id, entity_id: e.contributor ?? "", signature: e.signature }));

    const validation = await validateEpisode({
      manifest,
      streams,
      scores: { framingPercent: scores.framing.percent, plausibilityPercent: scores.plausibility.percent },
      requiredModalities: bounty.required_modalities,
      durationRangeS: bounty.duration_range_s,
      validator: deps.validatorId ?? null,
      fingerprint: { episode_id: episodeId, entity_id: rec.contributor ?? "", signature: scores.signature },
      priorFingerprints: prior,
    });

    const plausibility = scores.plausibility.percent === null ? null : scores.plausibility.percent / 100;
    const submission: EpisodeSubmission = {
      episode_id: episodeId,
      bounty_id: bounty.bounty_id,
      entity_id: rec.contributor ?? "",
      manifest_hash: rec.manifest_hash,
      duration_s: rec.duration_s,
      plausibility,
      framing: scores.framing.percent === null ? null : scores.framing.percent / 100,
      trust_level: rec.trust_level ?? "heuristic",
      ua_class: "other",
      recorded_at: rec.recorded_at,
    };
    const decision = evaluateEpisode(bounty, submission);
    const reasons = [...decision.reasons, ...validation.failures];

    // A live check, when the task asks for one, is part of being accepted: the asked-for movements must show up in the
    // picture and the gyroscope. Not a judgement call, so it never goes to a reviewer.
    let liveness: EpisodeRecord["liveness"];
    if (bounty.liveness === "require") {
      const asked = rec.liveness_prompts?.length ?? 0;
      const passed = !!scores.liveness?.passed;
      liveness = { required: true, passed, matched: scores.liveness?.matched ?? 0, total: asked };
      if (!passed) reasons.push(LIVENESS_FAILED);
    }

    // The take must be recorded in the task's escrow before it can be paid. Checked against the chain itself, not
    // against any signature the client reports, so a take that landed but whose upload was retried still counts.
    const ref = escrowRef(bounty);
    let anchor = rec.anchor;
    if (chain && ref && rec.contributor) {
      if (!anchorSignature && custodialSecret) {
        anchorSignature = await chain
          .anchor({ ref, episodeId, manifestHash: rec.manifest_hash, signerSecret: custodialSecret })
          .catch(() => null);
      } else if (!anchorSignature && relayFor && relayFor === rec.contributor) {
        // A wallet that signed in owns this take; the validator records it for them, so they never approve anything.
        anchorSignature = await chain
          .anchorFor({ ref, episodeId, manifestHash: rec.manifest_hash, contributor: rec.contributor })
          .catch(() => null);
      }
      const verified = await chain
        .verifySubmission({ ref, episodeId, manifestHash: rec.manifest_hash, contributor: rec.contributor })
        .catch(() => false);
      anchor = verified || anchorSignature
        ? { cluster: chain.cluster, contributor: rec.contributor, signature: anchorSignature ?? "", verified, anchored_at: Math.floor(Date.now() / 1000) }
        : undefined;
      if (deps.requireAnchor && !verified) reasons.push(NOT_FOUND);
    }

    const accepted = decision.accepted && validation.failures.length === 0 && reasons.length === 0;

    // Close calls go to a person before anyone is paid or refused. Integrity and anchoring problems never do:
    // those are not judgement calls.
    const hardProblem = validation.failures.length > 0 || reasons.some((r) => /not found on Solana|live head-movement/.test(r));
    const onlyMotionMiss = !decision.accepted && decision.reasons.length === 1 && /Motion match/.test(decision.reasons[0]);
    const needsReview =
      bounty.review_policy === "borderline" && !hardProblem && plausibility !== null &&
      Math.abs(plausibility - bounty.min_plausibility) <= REVIEW_BAND && (decision.accepted || onlyMotionMiss);
    if (needsReview) {
      store.update(episodeId, {
        status: "in_review", accepted: false, reasons: [], plausibility, framing: submission.framing,
        hands_visible_percent: scores.framing.visibilityPercent, signature: scores.signature, validation, anchor, liveness,
        review: { status: "pending", auto_accepted: decision.accepted },
      });
      try { store.saveBlob(episodeId, "traces.json", Buffer.from(JSON.stringify(scores.traces))); } catch { /* chart only */ }
      return;
    }

    store.update(episodeId, {
      status: "scored",
      accepted,
      reasons,
      plausibility,
      framing: submission.framing,
      hands_visible_percent: scores.framing.visibilityPercent,
      signature: scores.signature,
      validation,
      anchor,
      liveness,
    });
    // The evidence behind the motion score, for the app to draw. Best effort: a missing chart never blocks payment.
    try { store.saveBlob(episodeId, "traces.json", Buffer.from(JSON.stringify(scores.traces))); } catch { /* chart only */ }

    deps.onDecided?.(episodeId, accepted);

    // Money moves only through the escrow: accepted takes are paid from the task's vault; everything else on-chain is refused,
    // which releases the vault's reservation for the next contributor.
    if (accepted) await settleAccept(deps, episodeId, bounty, scoreBps(plausibility));
    else if (anchor?.verified) await settleReject(deps, episodeId, bounty, scoreBps(plausibility));
  } catch (err) {
    store.update(episodeId, {
      status: "failed",
      accepted: false,
      scoring_error: err instanceof Error ? err.message : String(err),
    });
    // A take we could not score must not hold a reservation on the task's money.
    await settleReject(deps, episodeId, bounty, 0).catch(() => undefined);
  }
}

/** Releases the task's per-take amount to the contributor, once. A failure is recorded on the take, never thrown. */
export async function settleAccept(deps: PipelineDeps, episodeId: string, bounty: Bounty, bps: number) {
  const { store, chain } = deps;
  const rec = store.get(episodeId);
  const ref = escrowRef(bounty);
  if (!chain || !rec?.contributor || rec.chain_settled || rec.payment || settling.has(episodeId)) return;
  const contributor = rec.contributor;
  const failure = (error: string) =>
    store.update(episodeId, {
      payment: { cluster: chain.cluster, contributor, amount_usdc: bounty.per_episode_usdc, signature: "", paid_at: Math.floor(Date.now() / 1000), error },
    });
  if (!ref) return void failure("This task has no escrow to pay from.");
  settling.add(episodeId);
  try {
    const signature = await chain.accept({ ref, episodeId, contributor, scoreBps: bps });
    store.update(episodeId, {
      chain_settled: "accepted",
      payment: { cluster: chain.cluster, contributor, amount_usdc: bounty.per_episode_usdc, signature, paid_at: Math.floor(Date.now() / 1000) },
    });
    deps.onPaid?.(bounty.bounty_id);
  } catch (err) {
    failure(err instanceof Error ? err.message : String(err));
  } finally {
    settling.delete(episodeId);
  }
}

/** Refuses the take in the escrow so its reservation is released. Best effort: a take that never reached the chain is fine. */
export async function settleReject(deps: PipelineDeps, episodeId: string, bounty: Bounty, bps: number) {
  const { store, chain } = deps;
  const rec = store.get(episodeId);
  const ref = escrowRef(bounty);
  if (!chain || !ref || !rec || rec.chain_settled || settling.has(episodeId)) return;
  settling.add(episodeId);
  try {
    await chain.reject({ ref, episodeId, scoreBps: bps });
    store.update(episodeId, { chain_settled: "rejected" });
  } catch {
    // Nothing recorded on-chain for this take, or already decided: either way there is no reservation to free.
  } finally {
    settling.delete(episodeId);
  }
}

export type { EpisodeRecord };
