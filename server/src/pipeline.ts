import { evaluateEpisode } from "@/lib/market/acceptance";
import type { Bounty, EpisodeSubmission } from "@/lib/market/types";
import type { Manifest } from "@/lib/manifest";
import type { EpisodeFingerprint } from "@/lib/validator/duplicate";
import { validateEpisode, type StreamBytes } from "@/lib/validator/validate";
import type { Scores } from "@/lib/validator/score";
import { memoText, type ChainPort } from "./solana/chain";
import type { EpisodeRecord, Store } from "./store";

export type ScoreFn = (video: Uint8Array, imu: Uint8Array) => Promise<Scores>;

export interface PipelineDeps {
  store: Store;
  chain: ChainPort | null;
  score: ScoreFn;
  /** When true an episode is only accepted once its memo is found on chain. */
  requireAnchor: boolean;
  validatorId?: string | null;
}

const paying = new Set<string>();

/**
 * Score, validate, decide, and (only for accepted + anchored episodes) pay.
 * Every failure is written onto the episode so nothing sits in "scoring" forever,
 * and a payout can only ever happen once per episode.
 */
export async function runPipeline(
  deps: PipelineDeps,
  args: { episodeId: string; bounty: Bounty; manifest: Manifest; streams: StreamBytes[]; anchorSignature: string | null },
): Promise<void> {
  const { store, chain } = deps;
  const { episodeId, bounty, manifest, streams, anchorSignature } = args;
  try {
    const video = streams.find((s) => s.kind === "rgb");
    const imu = streams.find((s) => s.kind === "imu");
    if (!video) throw new Error("No video stream was uploaded, so nothing can be scored.");

    const scores = await deps.score(video.bytes, imu?.bytes ?? new Uint8Array());
    const rec = store.get(episodeId)!;

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
      trust_level: "heuristic",
      ua_class: "other",
      recorded_at: rec.recorded_at,
    };
    const decision = evaluateEpisode(bounty, submission);
    const reasons = [...decision.reasons, ...validation.failures];

    let anchor = rec.anchor;
    if (chain && rec.contributor) {
      if (!anchorSignature) {
        anchor = undefined;
      } else {
        const verified = await chain
          .verifyMemo(anchorSignature, {
            signer: rec.contributor,
            memo: memoText(bounty.bounty_id, episodeId, rec.manifest_hash),
          })
          .catch(() => false);
        anchor = {
          cluster: chain.cluster,
          contributor: rec.contributor,
          signature: anchorSignature,
          verified,
          anchored_at: Math.floor(Date.now() / 1000),
        };
      }
      if (deps.requireAnchor && !anchor?.verified) {
        reasons.push("The submission was not found on Solana, so it cannot be paid.");
      }
    }

    const accepted = decision.accepted && validation.failures.length === 0 && reasons.length === 0;

    store.update(episodeId, {
      status: "scored",
      accepted,
      reasons,
      plausibility,
      signature: scores.signature,
      validation,
      anchor,
    });

    if (accepted && chain && rec.contributor) await payOnce(deps, episodeId, rec.contributor, decision.paid_usdc);
  } catch (err) {
    store.update(episodeId, {
      status: "failed",
      accepted: false,
      scoring_error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function payOnce(deps: PipelineDeps, episodeId: string, contributor: string, amountUsdc: number) {
  const { store, chain } = deps;
  if (!chain || store.get(episodeId)?.payment || paying.has(episodeId)) return;
  paying.add(episodeId);
  try {
    const signature = await chain.pay({ contributor, amountUsdc, episodeId });
    store.update(episodeId, {
      payment: { cluster: chain.cluster, contributor, amount_usdc: amountUsdc, signature, paid_at: Math.floor(Date.now() / 1000) },
    });
  } catch (err) {
    store.update(episodeId, {
      payment: {
        cluster: chain.cluster,
        contributor,
        amount_usdc: amountUsdc,
        signature: "",
        paid_at: Math.floor(Date.now() / 1000),
        error: err instanceof Error ? err.message : String(err),
      },
    });
  } finally {
    paying.delete(episodeId);
  }
}

export type { EpisodeRecord };
