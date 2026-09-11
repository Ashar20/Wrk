import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import Busboy from "busboy";
import { BOUNTIES } from "./bounties";
import { runPipeline, type PipelineDeps } from "./pipeline";
import type { EpisodeRecord } from "./store";
import { redactThresholds } from "@/lib/market/types";
import type { Manifest } from "@/lib/manifest";
import { validateEpisode, type StreamBytes } from "@/lib/validator/validate";

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function parseMultipart(req: IncomingMessage) {
  return new Promise<{ fields: Record<string, string>; files: Record<string, Buffer> }>((resolve, reject) => {
    const fields: Record<string, string> = {};
    const files: Record<string, Buffer> = {};
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 4, fields: 8 } });
    bb.on("field", (name, value) => (fields[name] = value));
    bb.on("file", (name, stream) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("limit", () => reject(Object.assign(new Error("Upload exceeds the size limit."), { status: 413 })));
      stream.on("end", () => (files[name] = Buffer.concat(chunks)));
    });
    bb.on("close", () => resolve({ fields, files }));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

/** What the app is allowed to see. Never includes thresholds or internal fingerprints. */
export function publicEpisode(e: EpisodeRecord) {
  return {
    episode_id: e.episode_id,
    bounty_id: e.bounty_id,
    status: e.status,
    accepted: e.status === "scored" ? e.accepted : null,
    reasons: e.reasons,
    plausibility: e.plausibility,
    manifest_hash: e.manifest_hash,
    anchor: e.anchor ?? null,
    payment: e.payment && !e.payment.error ? e.payment : null,
    payment_error: e.payment?.error ?? null,
    scoring_error: e.scoring_error ?? null,
  };
}

export function createHttpServer(deps: PipelineDeps): Server {
  const { store } = deps;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "OPTIONS") return send(res, 204, {});

      if (req.method === "GET" && url.pathname === "/bounties") {
        return send(res, 200, { bounties: BOUNTIES.map(redactThresholds) });
      }

      const m = /^\/episodes\/([\w-]+)$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const e = store.get(m[1]);
        return e ? send(res, 200, publicEpisode(e)) : send(res, 404, { error: "No such episode." });
      }

      if (req.method === "POST" && url.pathname === "/episodes") {
        if (!(req.headers["content-type"] ?? "").includes("multipart/form-data")) {
          return send(res, 400, { error: "Episodes must be uploaded as multipart/form-data." });
        }
        const { fields, files } = await parseMultipart(req);
        let manifest: Manifest;
        try {
          manifest = JSON.parse(fields.manifest ?? "") as Manifest;
        } catch {
          return send(res, 400, { error: "manifest is missing or not valid JSON." });
        }
        const episodeId = String(manifest.episode_id ?? "");
        const hash = String(manifest.manifest_hash ?? "");
        if (!/^ep_[0-9a-f]{8,}$/.test(episodeId)) return send(res, 400, { error: "episode_id is invalid." });
        if (!/^0x[0-9a-f]{64}$/.test(hash)) return send(res, 400, { error: "manifest_hash is not a SHA-256 digest." });

        // Idempotent: a retried upload returns what is already there and never rescoring or repaying.
        const existing = store.get(episodeId);
        if (existing) return send(res, 200, publicEpisode(existing));

        const bounty = BOUNTIES.find((b) => b.bounty_id === manifest.bounty_id);
        if (!bounty) return send(res, 404, { error: "No such bounty." });

        const declared = (manifest.streams ?? {}) as Record<string, { sha256: string }>;
        const streams: StreamBytes[] = [];
        for (const [kind, meta] of Object.entries(declared)) {
          const bytes = files[kind];
          if (bytes) streams.push({ kind, sha256: meta.sha256, bytes: new Uint8Array(bytes) });
        }
        if (streams.length === 0) return send(res, 400, { error: "No stream bytes were uploaded." });

        const integrity = await validateEpisode({
          manifest,
          streams,
          requiredModalities: bounty.required_modalities,
          durationRangeS: bounty.duration_range_s,
        });
        if (!integrity.checks.manifest_intact || !integrity.checks.streams_intact) {
          return send(res, 422, { error: "Integrity check failed.", failures: integrity.failures });
        }

        for (const s of streams) store.saveBlob(episodeId, s.kind, s.bytes);
        const rec = store.put({
          episode_id: episodeId,
          bounty_id: bounty.bounty_id,
          contributor: typeof manifest.contributor === "string" ? manifest.contributor : null,
          manifest_hash: hash,
          duration_s: Number(manifest.duration_s) || 0,
          recorded_at: Number(manifest.recorded_at) || 0,
          status: "scoring",
          accepted: false,
          reasons: [],
          plausibility: null,
          signature: [],
          received_at: Math.floor(Date.now() / 1000),
        });

        void runPipeline(deps, {
          episodeId,
          bounty,
          manifest,
          streams,
          anchorSignature: fields.anchor_signature || null,
        });
        return send(res, 202, publicEpisode(rec));
      }

      send(res, 404, { error: "Not found." });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
