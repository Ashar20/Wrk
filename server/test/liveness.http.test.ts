import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Accounts } from "../src/accounts";
import { BountyStore } from "../src/bountyStore";
import { createHttpServer } from "../src/http";
import type { Mailer } from "../src/mailer";
import { Store } from "../src/store";
import { sealManifest, sha256Hex } from "@/lib/manifest";
import type { Prompt } from "@/lib/analysis/liveness";
import type { ScoreOptions, Scores } from "@/lib/validator/score";
import { FakeChain } from "./fakeChain";

class CaptureMailer implements Mailer {
  codes: Record<string, string> = {};
  async sendCode(to: string, code: string) { this.codes[to] = code; }
}

describe("the live check, end to end", () => {
  let base = ""; let server: ReturnType<typeof createHttpServer>;
  let chain: FakeChain; let bounties: BountyStore; let mailer: CaptureMailer; let n = 0;
  let plausibility = 85; let livenessPasses = true; let seen: ScoreOptions | undefined;

  const scores = (opts?: ScoreOptions): Scores => ({
    framing: { verdict: "ok", percent: 80, framesAnalyzed: 10, framesWithHands: 9, framesInGuide: 8, visibilityPercent: 90 },
    plausibility: { percent: plausibility } as Scores["plausibility"], traces: [], signature: [randomBytes(8).toString("hex")], framesAnalyzed: 10, elapsedMs: 1,
    liveness: opts?.prompts ? { total: opts.prompts.length, matched: livenessPasses ? opts.prompts.length : 0, passed: livenessPasses, windows: [] } : undefined,
  });

  beforeEach(async () => {
    chain = new FakeChain(); mailer = new CaptureMailer(); n = 0; plausibility = 85; livenessPasses = true; seen = undefined;
    bounties = new BountyStore(mkdtempSync(join(tmpdir(), "wrk-b-")));
    await chain.seed(bounties);
    server = createHttpServer({
      store: new Store(mkdtempSync(join(tmpdir(), "wrk-e-"))), accounts: new Accounts(mkdtempSync(join(tmpdir(), "wrk-a-")), mailer), bounties, chain,
      score: async (_v, _i, opts) => { seen = opts; return scores(opts); }, requireAnchor: true,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const api = async (path: string, init: { token?: string; json?: unknown } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.json !== undefined ? "POST" : "GET",
      headers: init.token ? { authorization: `Bearer ${init.token}` } : {},
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await res.text(); let body: any = text; try { body = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body };
  };
  const challenge = async () => (await api("/liveness/challenge")).body as { nonce: string; prompts: Prompt[] };
  const wallet = () => Keypair.generate().publicKey.toBase58();
  const refOf = (b: string) => ({ buyer: bounties.get(b)!.escrow!.buyer, bountyId: b });

  async function upload(bountyId: string, claim?: { nonce: unknown; prompts: unknown }, over: { id?: string } = {}) {
    const rgb = new Uint8Array(Array.from({ length: 400 }, (_, i) => (i + n) % 251)); const imu = new Uint8Array([9, 8, 7]);
    const id = over.id ?? "ep_" + (++n).toString(16).padStart(4, "0").repeat(6);
    const contributor = wallet();
    const manifest = await sealManifest({
      episode_id: id, schema_version: "0.2.0", bounty_id: bountyId, task: "t", contributor, duration_s: 15, recorded_at: 1757030400,
      ...(claim ? { liveness: claim as any } : {}),
      capture: { video: { fps_nominal: 30, fps_observed: 29.5 }, imu: { rate_hz_observed: 100 } },
      streams: { rgb: { sha256: await sha256Hex(rgb), bytes: 400, content_type: "video/mp4" }, imu: { sha256: await sha256Hex(imu), bytes: 3, content_type: "application/octet-stream" } },
    });
    chain.walletSubmit(refOf(bountyId), id, manifest.manifest_hash, contributor);
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest)); form.set("rgb", new Blob([rgb])); form.set("imu", new Blob([imu]));
    const res = await fetch(`${base}/episodes`, { method: "POST", body: form });
    const text = await res.text(); let body: any = text; try { body = JSON.parse(text); } catch { /* */ }
    return { id, status: res.status, body, form };
  }
  const settled = async (id: string) => {
    for (let i = 0; i < 100; i++) { const v = (await api(`/episodes/${id}`)).body; if (v.status !== "scoring") return v; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error("never settled");
  };

  it("hands out a fresh random sequence each time", async () => {
    const a = await challenge(); const b = await challenge();
    expect(a.prompts).toHaveLength(4); expect(a.nonce).not.toBe(b.nonce);
    expect(a.prompts.every((p) => ["yaw", "pitch"].includes(p.axis) && p.at_ms > 0)).toBe(true);
  });

  it("tells contributors which tasks need it, and what the demo task pays for it", async () => {
    const feed = (await api("/bounties")).body.bounties as any[];
    expect(feed.find((b) => b.bounty_id === "bounty_008")).toMatchObject({ liveness: "require", per_episode_usdc: 75 });
    expect(feed.find((b) => b.bounty_id === "bounty_004").liveness).toBe("off");
  });

  it("pays a take that did what was asked, and hands the scorer exactly the sequence that was issued", async () => {
    const c = await challenge();
    const u = await upload("bounty_008", { nonce: c.nonce, prompts: c.prompts.slice(0, 3) });
    expect(u.status).toBe(202);
    const v = await settled(u.id);
    expect(v.accepted).toBe(true); expect(v.payment.amount_usdc).toBe(75);
    expect(v.liveness).toEqual({ required: true, passed: true, matched: 3, total: 3 });
    expect(seen?.prompts).toEqual(c.prompts.slice(0, 3));
  });

  it("refuses to pay a take whose movements didn't show up, and says why", async () => {
    livenessPasses = false;
    const c = await challenge();
    const u = await upload("bounty_008", { nonce: c.nonce, prompts: c.prompts.slice(0, 2) });
    const v = await settled(u.id);
    expect(v.accepted).toBe(false); expect(v.reasons.join(" ")).toMatch(/live head-movement check/);
    expect(v.liveness).toMatchObject({ required: true, passed: false, total: 2 });
    expect(chain.payouts).toHaveLength(0);
    expect(chain.rejected).toContain(u.id); // the reservation is released
  });

  it("won't take an upload that skipped the check, reused a spent challenge, or made one up", async () => {
    expect((await upload("bounty_008")).status).toBe(400);
    const c = await challenge();
    expect((await upload("bounty_008", { nonce: c.nonce, prompts: c.prompts.slice(0, 2) })).status).toBe(202);
    const reused = await upload("bounty_008", { nonce: c.nonce, prompts: c.prompts.slice(0, 2) });
    expect(reused.status).toBe(400); expect(reused.body.error).toMatch(/expired or was already used/);
    const d = await challenge();
    expect((await upload("bounty_008", { nonce: d.nonce, prompts: d.prompts.slice(0, 1) })).status).toBe(400); // too few
    const e = await challenge();
    expect((await upload("bounty_008", { nonce: e.nonce, prompts: e.prompts.map((p) => ({ ...p, axis: p.axis === "yaw" ? "pitch" : "yaw" })) })).status).toBe(400);
    expect((await upload("bounty_008", { nonce: "f".repeat(32), prompts: c.prompts })).status).toBe(400);
  });

  it("answers a retried upload from the stored take, even though its challenge is spent", async () => {
    const c = await challenge();
    const claim = { nonce: c.nonce, prompts: c.prompts.slice(0, 2) };
    const first = await upload("bounty_008", claim);
    expect(first.status).toBe(202);
    const again = await fetch(`${base}/episodes`, { method: "POST", body: first.form });
    expect(again.status).toBe(200); // same take, no second charge to the challenge, no second payout
    await settled(first.id);
    expect(chain.payouts).toHaveLength(1);
  });

  it("ignores the claim on tasks that have no live check, and doesn't spend the challenge", async () => {
    const c = await challenge();
    const u = await upload("bounty_004", { nonce: c.nonce, prompts: c.prompts.slice(0, 2) });
    expect(u.status).toBe(202); expect(seen?.prompts).toBeUndefined();
    expect((await settled(u.id)).liveness).toBeNull();
    expect((await upload("bounty_008", { nonce: c.nonce, prompts: c.prompts.slice(0, 2) })).status).toBe(202); // still unspent
  });

  it("lets a buyer require it, and never sends a failed live check to a human reviewer", async () => {
    await api("/auth/email/start", { json: { email: "livebuyer@example.com" } });
    const buyer = (await api("/auth/email/verify", { json: { email: "livebuyer@example.com", code: mailer.codes["livebuyer@example.com"] } })).body;
    const made = (await api("/buyer/bounties", { token: buyer.token, json: { title: "Careful task", task_spec: "Do the thing, first-person view.", per_episode_usdc: 10, min_episodes: 5, review_policy: "borderline", liveness: "require" } })).body.bounty;
    expect(made.liveness).toBe("require");

    plausibility = 62; livenessPasses = false; // close to the bar, which would normally wait for a person
    const c = await challenge();
    const u = await upload(made.bounty_id, { nonce: c.nonce, prompts: c.prompts.slice(0, 2) });
    const v = await settled(u.id);
    expect(v.status).toBe("scored"); expect(v.accepted).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/live head-movement/);
  });
});
