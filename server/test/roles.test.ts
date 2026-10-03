import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Accounts } from "../src/accounts";
import { BountyStore, budgetFor } from "../src/bountyStore";
import { createHttpServer } from "../src/http";
import type { Mailer } from "../src/mailer";
import { FakeChain } from "./fakeChain";
import { Store } from "../src/store";
import { budgetBreakdown } from "@/lib/market/types";
import { sealManifest, sha256Hex } from "@/lib/manifest";
import type { Scores } from "@/lib/validator/score";

const CONTRIBUTOR = "9xQeWvG816bUx9EPfEZEoPqdNaE4gqCNTNqmbFnfZoxM";

const scores = (percent: number | null, sig = "a"): Scores => ({
  framing: { verdict: "ok", percent: 80, framesAnalyzed: 10, framesWithHands: 9, framesInGuide: 8, visibilityPercent: 90 },
  plausibility: { percent } as Scores["plausibility"], traces: [], signature: [sig], framesAnalyzed: 10, elapsedMs: 1,
});

class CaptureMailer implements Mailer {
  codes: Record<string, string> = {};
  async sendCode(to: string, code: string) { this.codes[to] = code; }
}

describe("verifier, buyer and wallet roles", () => {
  let base = ""; let server: ReturnType<typeof createHttpServer>;
  let chain: FakeChain; let bountyStore: BountyStore; let mailer: CaptureMailer; let accounts: Accounts; let plausibility: number | null; let n = 0;

  beforeEach(async () => {
    chain = new FakeChain(); mailer = new CaptureMailer(); plausibility = 62; n = 0;
    accounts = new Accounts(mkdtempSync(join(tmpdir(), "wrk-acc-")), mailer);
    bountyStore = new BountyStore(mkdtempSync(join(tmpdir(), "wrk-b-")));
    await chain.seed(bountyStore);
    server = createHttpServer({
      store: new Store(mkdtempSync(join(tmpdir(), "wrk-r-"))), accounts, bounties: bountyStore,
      chain, score: async () => scores(plausibility, randomBytes(8).toString("hex")), requireAnchor: true,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const api = async (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
    const text = await res.text();
    let body: any = text; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, res };
  };

  async function signIn(email: string) {
    await api("/auth/email/start", { method: "POST", json: { email } });
    const r = await api("/auth/email/verify", { method: "POST", json: { email, code: mailer.codes[email] } });
    return r.body as { token: string; address: string };
  }

  async function submit(bountyId: string, opts: { contributor?: string; id?: string } = {}) {
    const rgb = new Uint8Array(Array.from({ length: 4000 }, (_, i) => i % 251));
    const imu = new Uint8Array([9, 8, 7]);
    const id = opts.id ?? "ep_" + (++n).toString(16).padStart(4, "0").repeat(6);
    const contributor = opts.contributor ?? CONTRIBUTOR;
    const manifest = await sealManifest({
      episode_id: id, schema_version: "0.2.0", bounty_id: bountyId, task: "t", contributor, duration_s: 15, recorded_at: 1757030400,
      capture: { video: { fps_nominal: 30, fps_observed: 29.5 }, imu: { rate_hz_observed: 100 } },
      streams: {
        rgb: { sha256: await sha256Hex(rgb), bytes: rgb.length, content_type: "video/mp4" },
        imu: { sha256: await sha256Hex(imu), bytes: imu.length, content_type: "application/octet-stream" },
      },
    });
    // a wallet user has already recorded the take in the task's escrow, whoever opened it
    chain.walletSubmit({ buyer: bountyStore.get(bountyId)!.escrow!.buyer, bountyId }, id, manifest.manifest_hash, contributor);
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest)); form.set("rgb", new Blob([rgb])); form.set("imu", new Blob([imu])); form.set("anchor_signature", `s-${id}`);
    const res = await fetch(`${base}/episodes`, { method: "POST", body: form });
    return { id, status: res.status };
  }

  const settled = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const v = (await api(`/episodes/${id}`)).body;
      if (v.status !== "scoring") return v;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("never settled");
  };

  // ---- wallet sign-in ----------------------------------------------------------------------------------------------
  function wallet() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const address = bs58.encode(raw);
    return { address, sign: (msg: string) => sign(null, Buffer.from(msg), privateKey).toString("base64") };
  }

  it("signs a wallet in only when it signed the challenge, once", async () => {
    const w = wallet();
    const c = (await api("/auth/wallet/challenge", { method: "POST", json: { address: w.address } })).body;
    expect(c.message).toContain(w.address);
    const ok = await api("/auth/wallet/verify", { method: "POST", json: { address: w.address, signature: w.sign(c.message) } });
    expect(ok.status).toBe(200);
    expect((await api("/me", { token: ok.body.token })).body.address).toBe(w.address);
    // the same challenge cannot be replayed
    expect((await api("/auth/wallet/verify", { method: "POST", json: { address: w.address, signature: w.sign(c.message) } })).status).toBe(400);
  });

  it("refuses a signature from a different key, a bad address and a garbled signature", async () => {
    const w = wallet(); const other = wallet();
    const c = (await api("/auth/wallet/challenge", { method: "POST", json: { address: w.address } })).body;
    expect((await api("/auth/wallet/verify", { method: "POST", json: { address: w.address, signature: other.sign(c.message) } })).status).toBe(401);
    const c2 = (await api("/auth/wallet/challenge", { method: "POST", json: { address: w.address } })).body;
    expect((await api("/auth/wallet/verify", { method: "POST", json: { address: w.address, signature: "AAAA" } })).status).toBe(401);
    expect(c2.message).not.toBe(c.message);
    expect((await api("/auth/wallet/challenge", { method: "POST", json: { address: "nope" } })).status).toBe(400);
  });

  // ---- review gate -------------------------------------------------------------------------------------------------
  it("holds a close call on a reviewed bounty for a person, and still auto-decides everything else", async () => {
    const a = await submit("bounty_007");
    const v = await settled(a.id);
    expect(v.status).toBe("in_review"); expect(v.accepted).toBeNull(); expect(chain.payouts).toHaveLength(0);

    const b = await submit("bounty_004"); // same score, bounty without review: decided immediately
    expect((await settled(b.id)).accepted).toBe(true);

    plausibility = 5; // a clear replay is refused outright, no human needed
    const c = await submit("bounty_007");
    const cv = await settled(c.id);
    expect(cv.status).toBe("scored"); expect(cv.accepted).toBe(false);
  });

  it("lets a verifier approve: the contributor is paid once and the verifier earns the fee", async () => {
    const a = await submit("bounty_007"); await settled(a.id);
    const verifier = await signIn("rev@example.com");
    const q = await api("/review/queue", { token: verifier.token });
    expect(q.body.items.map((i: any) => i.episode_id)).toContain(a.id);
    expect(q.body.items[0]).toMatchObject({ bounty_title: "Cup pick-and-place, reviewed", fee_usdc: 0.05, per_episode_usdc: 0.9 });
    expect(JSON.stringify(q.body)).not.toMatch(/min_plausibility|signature/);

    const d = await api(`/review/${a.id}/decision`, { method: "POST", token: verifier.token, json: { decision: "approve", note: "looks real" } });
    expect(d.status).toBe(200); expect(d.body.decision).toBe("approved");
    const after = await settled(a.id);
    expect(after.accepted).toBe(true); expect(after.payment.amount_usdc).toBe(0.9);
    expect(chain.payouts.map((p) => [p.contributor, p.amountUsdc])).toEqual([[CONTRIBUTOR, 0.9], [verifier.address, 0.05]]);

    expect((await api(`/review/${a.id}/decision`, { method: "POST", token: verifier.token, json: { decision: "reject" } })).status).toBe(409);
    const mine = await api("/review/mine", { token: verifier.token });
    expect(mine.body.earned_usdc).toBe(0.05); expect(mine.body.items[0]).toMatchObject({ decision: "approved", fee_usdc: 0.05 });
  });

  it("a rejection pays the verifier but never the contributor, and says why in plain words", async () => {
    const a = await submit("bounty_007"); await settled(a.id);
    const verifier = await signIn("rev2@example.com");
    expect((await api(`/review/${a.id}/decision`, { method: "POST", token: verifier.token, json: { decision: "reject" } })).status).toBe(200);
    const v = await settled(a.id);
    expect(v.accepted).toBe(false); expect(v.reasons.join(" ")).toMatch(/reviewer/i); expect(v.payment).toBeNull();
    expect(chain.payouts.map((p) => p.contributor)).toEqual([verifier.address]);
  });

  it("sends a near-miss rejection to a person, and a reviewer can overturn it", async () => {
    plausibility = 52; // 8 points under the 60% bar, with only the motion reason
    const a = await submit("bounty_007");
    expect((await settled(a.id)).status).toBe("in_review");
    const verifier = await signIn("rev3@example.com");
    await api(`/review/${a.id}/decision`, { method: "POST", token: verifier.token, json: { decision: "approve" } });
    expect((await settled(a.id)).accepted).toBe(true);
    expect(chain.payouts[0].contributor).toBe(CONTRIBUTOR);
  });

  it("keeps the queue honest: sign-in required, never your own take, no double decisions", async () => {
    const owner = await signIn("owner@example.com");
    const a = await submit("bounty_007", { contributor: owner.address }); // an email user's own take
    // email users are anchored by Wrk, so give this episode its anchor the way the API would
    await settled(a.id);
    expect((await api("/review/queue")).status).toBe(401);
    const own = await api("/review/queue", { token: owner.token });
    expect(own.body.items.map((i: any) => i.episode_id)).not.toContain(a.id);
    expect((await api(`/review/${a.id}/decision`, { method: "POST", token: owner.token, json: { decision: "approve" } })).status).toBe(404);
    expect((await api(`/review/${a.id}/decision`, { method: "POST", json: { decision: "approve" } })).status).toBe(401);
    const verifier = await signIn("rev4@example.com");
    expect((await api(`/review/${a.id}/decision`, { method: "POST", token: verifier.token, json: { decision: "maybe" } })).status).toBe(400);
  });

  it("streams the video with ranges so a phone can scrub it", async () => {
    const a = await submit("bounty_007"); await settled(a.id);
    const v = await signIn("rev5@example.com");
    const full = await fetch(`${base}/review/${a.id}/video`, { headers: { authorization: `Bearer ${v.token}` } });
    expect(full.status).toBe(200); expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect((await full.arrayBuffer()).byteLength).toBe(4000);
    const part = await fetch(`${base}/review/${a.id}/video`, { headers: { authorization: `Bearer ${v.token}`, range: "bytes=100-199" } });
    expect(part.status).toBe(206); expect(part.headers.get("content-range")).toBe("bytes 100-199/4000");
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const bad = await fetch(`${base}/review/${a.id}/video`, { headers: { authorization: `Bearer ${v.token}`, range: "bytes=9000-9999" } });
    expect(bad.status).toBe(416);
    expect((await fetch(`${base}/review/${a.id}/video`)).status).toBe(401);
  });

  // ---- buyer -------------------------------------------------------------------------------------------------------
  it("balances every bounty's money to the cent", () => {
    for (const [per, n] of [[0.6, 100], [0.37, 13], [2.5, 7], [0.1, 1]] as const) {
      const m = budgetFor(per, n);
      const b = { per_episode_usdc: per, min_episodes: n, ...m } as Parameters<typeof budgetBreakdown>[0];
      expect(budgetBreakdown(b).balanced).toBe(true);
    }
    expect(budgetFor(0.6, 100)).toMatchObject({ budget_usdc: 100, utility_pool_usdc: 30, validator_fee_usdc: 5, treasury_fee_usdc: 5 });
  });

  it("lets a buyer post a task that contributors then see, and rejects nonsense", async () => {
    const buyer = await signIn("buyer@example.com");
    const good = { title: "Water a plant", task_spec: "Water a houseplant with a small can, first-person.", per_episode_usdc: 0.75, min_episodes: 20, review_policy: "borderline" };
    expect((await api("/buyer/bounties", { method: "POST", json: good })).status).toBe(401);
    for (const bad of [{ ...good, title: "x" }, { ...good, per_episode_usdc: 50 }, { ...good, min_episodes: 0 }, { ...good, task_spec: "short" }]) {
      expect((await api("/buyer/bounties", { method: "POST", token: buyer.token, json: bad })).status).toBe(400);
    }
    const made = await api("/buyer/bounties", { method: "POST", token: buyer.token, json: good });
    expect(made.status).toBe(201);
    expect(made.body.bounty).toMatchObject({ title: "Water a plant", per_episode_usdc: 0.75, review_policy: "borderline", budget_usdc: 25 });
    expect(made.body.bounty).not.toHaveProperty("min_plausibility");
    const feed = (await api("/bounties")).body.bounties.map((b: any) => b.bounty_id);
    expect(feed).toContain(made.body.bounty.bounty_id);
  });

  it("shows a buyer their results, spend and score spread, and only their own datasets", async () => {
    const buyer = await signIn("buyer2@example.com");
    const other = await signIn("buyer3@example.com");
    const made = (await api("/buyer/bounties", { method: "POST", token: buyer.token, json: { title: "Fold a shirt", task_spec: "Fold a shirt on a bed, first-person view.", per_episode_usdc: 1, min_episodes: 5 } })).body.bounty;

    plausibility = 90; const ok = await submit(made.bounty_id); await settled(ok.id);
    plausibility = 5; const bad = await submit(made.bounty_id); await settled(bad.id);

    const s = (await api("/buyer/summary", { token: buyer.token })).body;
    const row = s.bounties.find((b: any) => b.bounty_id === made.bounty_id);
    expect(row).toMatchObject({ accepted: 1, rejected: 1, in_review: 0, spend_usdc: 1, owner_is_you: true });
    expect(row.histogram).toEqual([1, 0, 0, 0, 1]);
    expect(s.total_spend_usdc).toBeGreaterThanOrEqual(1);
    expect(s.bounties.some((b: any) => b.bounty_id === "bounty_004")).toBe(true); // the demo bounties are visible to everyone

    const ds = (await api(`/buyer/bounties/${made.bounty_id}/dataset`, { token: buyer.token })).body;
    expect(ds.episode_count).toBe(1);
    expect(ds.episodes[0]).toMatchObject({ episode_id: ok.id, payment_signature: expect.any(String), human_reviewed: false });
    expect(JSON.stringify(ds)).not.toMatch(/"rgb"|min_plausibility/);

    // another buyer cannot see this buyer's task or its data
    expect((await api(`/buyer/bounties/${made.bounty_id}/dataset`, { token: other.token })).status).toBe(404);
    expect((await api("/buyer/summary", { token: other.token })).body.bounties.some((b: any) => b.bounty_id === made.bounty_id)).toBe(false);
  });

  it("closes a task once it has paid for every take it asked for", async () => {
    const buyer = await signIn("buyer4@example.com");
    const made = (await api("/buyer/bounties", { method: "POST", token: buyer.token, json: { title: "One take only", task_spec: "Do the thing once, first-person view.", per_episode_usdc: 1, min_episodes: 1 } })).body.bounty;
    plausibility = 90;
    const first = await submit(made.bounty_id); await settled(first.id);
    expect((await api("/bounties")).body.bounties.some((b: any) => b.bounty_id === made.bounty_id)).toBe(false);
    // a full task also refuses new takes on-chain: the vault has no slot left to record one
    await expect(submit(made.bounty_id)).rejects.toThrow("BountyFull");
  });
});
