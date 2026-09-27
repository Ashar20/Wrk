import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import Busboy from "busboy";
import { runPipeline, type PipelineDeps } from "./pipeline";
import { AuthError, type Accounts } from "./accounts";
import { BountyInputError, type BountyStore } from "./bountyStore";
import { dataset, summary, visibleToBuyer } from "./buyer";
import { decide, historyFor, pendingFor, queueItem, ReviewError } from "./review";
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

export type HttpDeps = PipelineDeps & { accounts: Accounts; bounties: BountyStore };

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
  const { store, accounts, bounties } = deps;
  // A bounty closes itself once it has paid for as many takes as it asked for.
  const pdeps: PipelineDeps = {
    ...deps,
    onPaid: (bid) => {
      const b = bounties.get(bid);
      if (b && store.list().filter((e) => e.bounty_id === bid && e.payment && !e.payment.error).length >= b.min_episodes) bounties.close(bid);
    },
  };
  const requireSession = (req: IncomingMessage) => {
    const me = accounts.session(bearer(req));
    if (!me) throw new AuthError("Sign in first.", 401);
    return me;
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "OPTIONS") return send(res, 204, {});

      if (req.method === "GET" && url.pathname === "/bounties") {
        return send(res, 200, { bounties: bounties.list().filter((b) => b.status === "open").map(redactThresholds) });
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

      // --- wallet sign-in: sign a one-time challenge to prove you hold the address ---------------------------------------------
      if (req.method === "POST" && url.pathname === "/auth/wallet/challenge") {
        return send(res, 200, accounts.challenge(String((await readJson(req)).address ?? "")));
      }
      if (req.method === "POST" && url.pathname === "/auth/wallet/verify") {
        const b = await readJson(req);
        const sig = Buffer.from(String(b.signature ?? ""), "base64");
        const r = accounts.verifyWallet(String(b.address ?? ""), new Uint8Array(sig));
        return send(res, 200, { token: r.token, address: r.address });
      }

      // --- verifier: a queue of close calls, a player, and a decision --------------------------------------------------------
      if (req.method === "GET" && url.pathname === "/review/queue") {
        const me = requireSession(req);
        return send(res, 200, { items: pendingFor(store.list(), (id) => bounties.get(id), me) });
      }
      if (req.method === "GET" && url.pathname === "/review/mine") {
        const me = requireSession(req);
        return send(res, 200, historyFor(store.list(), (id) => bounties.get(id), me));
      }
      const rv = /^\/review\/(ep_[0-9a-f]{8,64})(?:\/(video|traces|decision))?$/.exec(url.pathname);
      if (rv) {
        const me = requireSession(req);
        const e = store.get(rv[1]);
        const b = e ? bounties.get(e.bounty_id) : undefined;
        const canSee = e && b && e.contributor !== me.address &&
          ((e.status === "in_review" && e.review?.status === "pending") || e.review?.reviewer === me.address);
        if (!e || !b || !canSee) return send(res, 404, { error: "That take isn't available to review." });
        const kind = rv[2];
        if (req.method === "GET" && !kind) return send(res, 200, queueItem(e, b));
        if (req.method === "GET" && kind === "traces") {
          const raw = store.readBlob(e.episode_id, "traces.json");
          return raw ? send(res, 200, { traces: JSON.parse(raw.toString("utf8")) }) : send(res, 404, { error: "No traces for that take." });
        }
        if (req.method === "GET" && kind === "video") {
          const video = store.readBlob(e.episode_id, "rgb");
          if (!video) return send(res, 404, { error: "No video for that take." });
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
          if (!range) {
            res.writeHead(200, { "content-type": "video/mp4", "content-length": video.length, "accept-ranges": "bytes" });
            return void res.end(video);
          }
          const start = range[1] === "" ? Math.max(0, video.length - Number(range[2])) : Number(range[1]);
          const end = range[1] === "" || range[2] === "" ? video.length - 1 : Math.min(Number(range[2]), video.length - 1);
          if (!(start <= end) || start >= video.length) {
            res.writeHead(416, { "content-range": `bytes */${video.length}` });
            return void res.end();
          }
          res.writeHead(206, { "content-type": "video/mp4", "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${video.length}`, "accept-ranges": "bytes" });
          return void res.end(video.subarray(start, end + 1));
        }
        if (req.method === "POST" && kind === "decision") {
          const body = await readJson(req);
          if (body.decision !== "approve" && body.decision !== "reject") return send(res, 400, { error: "Decide approve or reject." });
          const done = await decide(pdeps, e.episode_id, me, body.decision, String(body.note ?? ""), b);
          return send(res, 200, { decision: done.review?.status, fee: done.review?.fee ?? null });
        }
      }

      // --- buyer: post tasks, watch results, take the dataset manifest -----------------------------------------------------
      if (req.method === "POST" && url.pathname === "/buyer/bounties") {
        const me = requireSession(req);
        const b = await readJson(req);
        const made = bounties.create(
          {
            title: String(b.title ?? ""), task_spec: String(b.task_spec ?? ""),
            per_episode_usdc: Number(b.per_episode_usdc), min_episodes: Number(b.min_episodes),
            review_policy: b.review_policy === "borderline" ? "borderline" : "none",
          },
          me.address,
        );
        return send(res, 201, { bounty: redactThresholds(made) });
      }
      if (req.method === "GET" && url.pathname === "/buyer/summary") {
        const me = requireSession(req);
        return send(res, 200, summary(store.list(), bounties.list(), me.address));
      }
      const bd = /^\/buyer\/bounties\/([\w-]+)\/dataset$/.exec(url.pathname);
      if (req.method === "GET" && bd) {
        const me = requireSession(req);
        const b = bounties.get(bd[1]);
        if (!b || !visibleToBuyer(b, me.address)) return send(res, 404, { error: "No such task." });
        return send(res, 200, dataset(store.list(), b));
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

        const bounty = bounties.get(String(manifest.bounty_id));
        if (!bounty) return send(res, 404, { error: "No such bounty." });
        if (bounty.status !== "open") return send(res, 409, { error: "This task has all the takes it needs." });

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

        void runPipeline(pdeps, {
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
      const status = err instanceof AuthError || err instanceof ReviewError ? err.status : err instanceof BountyInputError ? 400 : ((err as { status?: number }).status ?? 500);
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
