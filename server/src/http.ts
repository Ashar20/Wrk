import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import Busboy from "busboy";
import { BOUNTIES } from "./bounties";
import { runPipeline, type PipelineDeps } from "./pipeline";
import { AuthError, type Accounts } from "./accounts";
import type { EpisodeRecord } from "./store";
import { redactThresholds } from "@/lib/market/types";
import type { Manifest } from "@/lib/manifest";
import { validateEpisode, type StreamBytes } from "@/lib/validator/validate";
import { liveMeta, liveModelAvailable } from "@/lib/worldmodel/live-model";
import { predictNext, THUMBNAIL_SIZE } from "@/lib/worldmodel/predict";

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

/** Raw request body, refusing anything larger than [limit] bytes. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw Object.assign(new Error("Request too large."), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const MAX_PREDICTIONS = 120;

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
  const checks = e.validation?.checks;
  return {
    episode_id: e.episode_id,
    bounty_id: e.bounty_id,
    status: e.status,
    accepted: e.status === "scored" ? e.accepted : null,
    reasons: e.reasons,
    plausibility: e.plausibility,
    framing: e.framing ?? null,
    hands_visible_percent: e.hands_visible_percent ?? null,
    flow_gyro_corr: checks?.flow_gyro_corr ?? null,
    validator_score: e.validation?.plausibility_score ?? null,
    checks: checks ? { manifest_intact: checks.manifest_intact, streams_intact: checks.streams_intact, duplicate_of: checks.duplicate_of } : null,
    manifest_hash: e.manifest_hash,
    anchor: e.anchor ?? null,
    payment: e.payment && !e.payment.error ? e.payment : null,
    payment_error: e.payment?.error ?? null,
    scoring_error: e.scoring_error ?? null,
  };
}

export type HttpDeps = PipelineDeps & { accounts: Accounts };

const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 10_000) throw new AuthError("Request too large.", 413);
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new AuthError("Body is not valid JSON.");
  }
}

export function createHttpServer(deps: HttpDeps): Server {
  const { store, accounts } = deps;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "OPTIONS") return send(res, 204, {});

      if (req.method === "GET" && url.pathname === "/bounties") {
        return send(res, 200, { bounties: BOUNTIES.map(redactThresholds) });
      }

      if (req.method === "POST" && url.pathname === "/auth/email/start") {
        await accounts.start(String((await readJson(req)).email ?? ""));
        return send(res, 200, { sent: true });
      }
      if (req.method === "POST" && url.pathname === "/auth/email/verify") {
        const b = await readJson(req);
        const r = accounts.verify(String(b.email ?? ""), String(b.code ?? ""));
        return send(res, 200, { token: r.token, address: r.address, email: r.email });
      }
      if (req.method === "GET" && url.pathname === "/me") {
        const me = accounts.session(bearer(req));
        return me ? send(res, 200, me) : send(res, 401, { error: "Not signed in." });
      }

      // --- live world-model guess: a small square crop in, the nearest earlier frame out -------------
      if (req.method === "GET" && url.pathname === "/predict") {
        if (!liveModelAvailable()) return send(res, 200, { available: false });
        const meta = await liveMeta();
        return send(res, 200, { available: true, size: meta.size, thumbnailSize: THUMBNAIL_SIZE });
      }
      if (req.method === "POST" && url.pathname === "/predict") {
        if (!liveModelAvailable()) return send(res, 501, { error: "No live model is available." });
        const session = url.searchParams.get("session") ?? "";
        if (!/^[\w-]{8,64}$/.test(session)) return send(res, 400, { error: "A session id is required." });
        const meta = await liveMeta();
        const motion = ["ax", "ay", "az", "rx", "ry", "rz"].map((k) => {
          const v = Number(url.searchParams.get(k));
          return Number.isFinite(v) ? v : 0;
        });
        const rgb = new Uint8Array(await readBody(req, meta.size * meta.size * 3 + 1));
        if (rgb.length !== meta.size * meta.size * 3) {
          return send(res, 400, { error: `Expected ${meta.size * meta.size * 3} bytes of ${meta.size}x${meta.size} RGB.` });
        }
        const out = await predictNext({ sessionId: session, rgb, motion });
        if (!out) return send(res, 501, { error: "No live model is available." });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "x-thumbnail-size": String(out.thumbnailSize),
          "x-distance": String(out.distance),
          "x-bank-size": String(out.bankSize),
          "x-warming": String(out.warming),
          "cache-control": "no-store",
          "access-control-expose-headers": "x-thumbnail-size,x-distance,x-bank-size,x-warming",
        });
        return void res.end(Buffer.from(out.thumbnail));
      }

      const sub = /^\/episodes\/([\w-]+)\/(traces|predictions)$/.exec(url.pathname);
      if (sub) {
        const [, id, kind] = sub;
        if (!/^ep_[0-9a-f]{8,64}$/.test(id) || !store.get(id)) return send(res, 404, { error: "No such episode." });
        const file = `${kind}.json`;
        if (req.method === "GET") {
          const raw = store.readBlob(id, file);
          return raw ? send(res, 200, { [kind]: JSON.parse(raw.toString("utf8")) }) : send(res, 404, { error: `No ${kind} for that episode.` });
        }
        if (req.method === "POST" && kind === "predictions") {
          let body: { predictions?: unknown };
          try { body = JSON.parse((await readBody(req, 6_000_000)).toString("utf8")); } catch { return send(res, 400, { error: "Body must be JSON." }); }
          if (!Array.isArray(body.predictions)) return send(res, 400, { error: "predictions must be an array." });
          const clean = body.predictions.filter(
            (p): p is { t: number; distance: number; warming: boolean; thumbnail: string } =>
              typeof p === "object" && p !== null &&
              typeof (p as { t?: unknown }).t === "number" && typeof (p as { distance?: unknown }).distance === "number" &&
              typeof (p as { warming?: unknown }).warming === "boolean" &&
              typeof (p as { thumbnail?: unknown }).thumbnail === "string" && (p as { thumbnail: string }).thumbnail.startsWith("data:image/"),
          ).slice(0, MAX_PREDICTIONS);
          store.saveBlob(id, file, Buffer.from(JSON.stringify(clean)));
          return send(res, 200, { ok: true, count: clean.length });
        }
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

        // An email session may only submit as its own payment account.
        const token = bearer(req);
        const me = accounts.session(token);
        if (token && !me) return send(res, 401, { error: "Your sign-in expired. Sign in again." });
        if (me && manifest.contributor !== me.address) return send(res, 403, { error: "This episode belongs to a different payment account." });

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
          custodialSecret: me && !fields.anchor_signature ? accounts.secretFor(me.email) : null,
        });
        return send(res, 202, publicEpisode(rec));
      }

      send(res, 404, { error: "Not found." });
    } catch (err) {
      const status = err instanceof AuthError ? err.status : ((err as { status?: number }).status ?? 500);
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
