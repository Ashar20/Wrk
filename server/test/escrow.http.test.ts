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
import type { Scores } from "@/lib/validator/score";
import { FakeChain } from "./fakeChain";

const scores = (percent: number | null): Scores => ({
  framing: { verdict: "ok", percent: 80, framesAnalyzed: 10, framesWithHands: 9, framesInGuide: 8, visibilityPercent: 90 },
  plausibility: { percent } as Scores["plausibility"], traces: [], signature: [randomBytes(8).toString("hex")], framesAnalyzed: 10, elapsedMs: 1,
});

class CaptureMailer implements Mailer {
  codes: Record<string, string> = {};
  async sendCode(to: string, code: string) { this.codes[to] = code; }
}

describe("money moves only through the task's escrow", () => {
  let base = ""; let server: ReturnType<typeof createHttpServer>;
  let chain: FakeChain; let bounties: BountyStore; let mailer: CaptureMailer; let plausibility: number | null; let scoreFails = false; let n = 0;

  beforeEach(async () => {
    chain = new FakeChain(); mailer = new CaptureMailer(); plausibility = 80; scoreFails = false; n = 0;
    bounties = new BountyStore(mkdtempSync(join(tmpdir(), "wrk-b-")));
    await chain.seed(bounties);
    server = createHttpServer({
      store: new Store(mkdtempSync(join(tmpdir(), "wrk-e-"))), accounts: new Accounts(mkdtempSync(join(tmpdir(), "wrk-a-")), mailer), bounties, chain,
      score: async () => { if (scoreFails) throw new Error("no frames"); return scores(plausibility); }, requireAnchor: true,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const api = async (path: string, init: { token?: string; json?: unknown; method?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers: init.token ? { authorization: `Bearer ${init.token}` } : {},
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await res.text(); let body: any = text; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
  };
  const signIn = async (email: string) => {
    await api("/auth/email/start", { json: { email } });
    return (await api("/auth/email/verify", { json: { email, code: mailer.codes[email] } })).body as { token: string; address: string };
  };
  const wallet = () => Keypair.generate().publicKey.toBase58();
  const epId = () => "ep_" + (++n).toString(16).padStart(4, "0").repeat(6);
  const refOf = (bountyId: string) => ({ buyer: bounties.get(bountyId)!.escrow!.buyer, bountyId });

  async function upload(bountyId: string, contributor: string, opts: { id?: string; token?: string; submitOnChain?: boolean } = {}) {
    const rgb = new Uint8Array(Array.from({ length: 500 }, (_, i) => i % 251)); const imu = new Uint8Array([9, 8, 7]);
    const id = opts.id ?? epId();
    const manifest = await sealManifest({
      episode_id: id, schema_version: "0.2.0", bounty_id: bountyId, task: "t", contributor, duration_s: 15, recorded_at: 1757030400,
      capture: { video: { fps_nominal: 30, fps_observed: 29.5 }, imu: { rate_hz_observed: 100 } },
      streams: { rgb: { sha256: await sha256Hex(rgb), bytes: 500, content_type: "video/mp4" }, imu: { sha256: await sha256Hex(imu), bytes: 3, content_type: "application/octet-stream" } },
    });
    if (opts.submitOnChain !== false && !opts.token) chain.walletSubmit(refOf(bountyId), id, manifest.manifest_hash, contributor);
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest)); form.set("rgb", new Blob([rgb])); form.set("imu", new Blob([imu]));
    const res = await fetch(`${base}/episodes`, { method: "POST", body: form, headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {} });
    return { id, status: res.status, hash: manifest.manifest_hash };
  }
  const settled = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const v = (await api(`/episodes/${id}`)).body;
      if (v.status !== "scoring") return v;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("never settled");
  };
  const vault = (bountyId: string) => chain.vaults.get(`${refOf(bountyId).buyer}|${bountyId}`)!;

  it("pays an accepted take out of the vault, and nothing else ever pays a contributor", async () => {
    const before = vault("bounty_004").vault;
    const c = wallet();
    const u = await upload("bounty_004", c);
    expect((await settled(u.id)).payment.signature).toMatch(/^accept-/);
    expect(vault("bounty_004").vault).toBeCloseTo(before - 40, 9);
    expect(chain.payouts.filter((p) => p.kind === "escrow")).toHaveLength(1);
    expect(chain.payouts.every((p) => p.kind === "escrow")).toBe(true);
  });

  it("releases the reservation when a take is refused, so the next contributor can use that slot", async () => {
    plausibility = 5;
    const u = await upload("bounty_004", wallet());
    expect((await settled(u.id)).accepted).toBe(false);
    expect(chain.rejected).toContain(u.id);
    expect(vault("bounty_004").pending).toBe(0);
    expect(vault("bounty_004").vault).toBeCloseTo(4000, 9); // untouched
  });

  it("releases the reservation when scoring itself fails", async () => {
    scoreFails = true;
    const u = await upload("bounty_004", wallet());
    expect((await settled(u.id)).status).toBe("failed");
    expect(chain.rejected).toContain(u.id);
    expect(vault("bounty_004").pending).toBe(0);
  });

  it("will not pay a take that was never recorded in the escrow", async () => {
    const u = await upload("bounty_004", wallet(), { submitOnChain: false });
    const v = await settled(u.id);
    expect(v.accepted).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/not found on Solana/);
    expect(chain.payouts).toHaveLength(0);
  });

  it("will not pay when the recorded take belongs to someone else or to different bytes", async () => {
    const real = wallet(), thief = wallet();
    const id = epId();
    chain.walletSubmit(refOf("bounty_004"), id, "0x" + "ab".repeat(32), real); // recorded with a different manifest hash
    const u = await upload("bounty_004", thief, { id, submitOnChain: false });
    expect((await settled(u.id)).accepted).toBe(false);
    expect(chain.payouts).toHaveLength(0);
  });

  it("does not pay when the vault can't cover the take: it can't even be recorded", async () => {
    const buyer = await signIn("tiny@example.com");
    const made = (await api("/buyer/bounties", { token: buyer.token, json: { title: "Two takes", task_spec: "Do the thing twice, first-person view.", per_episode_usdc: 10, min_episodes: 2 } })).body.bounty;
    chain.vaults.get(`${buyer.address}|${made.bounty_id}`)!.vault = 5; // less than one take's worth, e.g. after a refund
    const contributor = await signIn("second@example.com");
    const u = await upload(made.bounty_id, contributor.address, { token: contributor.token });
    const v = await settled(u.id);
    expect(v.accepted).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/not found on Solana/);
    expect(chain.payouts).toHaveLength(0);
  });

  // ---- buyers ------------------------------------------------------------------------------------------------
  it("locks an email buyer's funds before the task opens, from test funds minted for them", async () => {
    const buyer = await signIn("b1@example.com");
    const r = await api("/buyer/bounties", { token: buyer.token, json: { title: "Water a plant", task_spec: "Water a houseplant, first-person view.", per_episode_usdc: 30, min_episodes: 10 } });
    expect(r.status).toBe(201); expect(r.body.escrow.funded).toBe(true);
    expect(chain.faucets).toContainEqual({ address: buyer.address, amountUsdc: 300 });
    expect(vault(r.body.bounty.bounty_id).vault).toBe(300);
    expect((await api("/bounties")).body.bounties.map((b: any) => b.bounty_id)).toContain(r.body.bounty.bounty_id);
  });

  async function walletSession() {
    const crypto = await import("node:crypto");
    const w = crypto.generateKeyPairSync("ed25519");
    const bs58 = (await import("bs58")).default;
    const address = bs58.encode(w.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const c = (await api("/auth/wallet/challenge", { json: { address } })).body;
    const sig = crypto.sign(null, Buffer.from(c.message), w.privateKey).toString("base64");
    return { address, ...(await api("/auth/wallet/verify", { json: { address, signature: sig } })).body };
  }

  it("records a signed-in wallet's take for them, so they approve nothing and are still paid", async () => {
    const session = await walletSession();
    const u = await upload("bounty_004", session.address, { token: session.token });
    expect(u.status).toBe(202);
    const v = await settled(u.id);
    expect(v.accepted).toBe(true);
    expect(chain.anchored.map((a) => a.contributor)).toContain(session.address);
    expect(chain.payouts.map((p) => p.contributor)).toContain(session.address);
  });

  it("will not record a take for an address other than the one that signed in", async () => {
    const session = await walletSession();
    const u = await upload("bounty_004", wallet(), { token: session.token });
    expect(u.status).toBe(403);
  });

  it("keeps a wallet buyer's task hidden until their funding transaction lands", async () => {
    const buyer = await signIn("b2@example.com");
    // a wallet buyer has no custodial key; model one by posting through the session of a wallet user is covered in roles tests
    // here we exercise the wallet branch directly by marking the account as a wallet via the challenge flow
    const w = (await import("node:crypto")).generateKeyPairSync("ed25519");
    const raw = w.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const bs58 = (await import("bs58")).default; const address = bs58.encode(raw);
    const c = (await api("/auth/wallet/challenge", { json: { address } })).body;
    const sig = (await import("node:crypto")).sign(null, Buffer.from(c.message), w.privateKey).toString("base64");
    const session = (await api("/auth/wallet/verify", { json: { address, signature: sig } })).body;

    const r = await api("/buyer/bounties", { token: session.token, json: { title: "Fold a shirt", task_spec: "Fold a shirt on a bed, first-person view.", per_episode_usdc: 10, min_episodes: 4 } });
    expect(r.status).toBe(201); expect(r.body.escrow.funded).toBe(false); expect(typeof r.body.escrow.tx).toBe("string");
    const id = r.body.bounty.bounty_id;
    expect((await api("/bounties")).body.bounties.map((b: any) => b.bounty_id)).not.toContain(id);
    expect((await upload(id, wallet(), { submitOnChain: false })).status).toBe(409); // not open for takes

    expect((await api(`/buyer/bounties/${id}/confirm`, { token: session.token, json: {} })).body.funded).toBe(false); // nothing on-chain yet
    const retry = await api(`/buyer/bounties/${id}/fund-tx`, { token: session.token, json: {} }); // walked away, came back
    expect(retry.status).toBe(200); expect(typeof retry.body.tx).toBe("string");
    chain.walletOpen(bounties.get(id)!, { buyer: address, bountyId: id }); // the wallet sends the transaction
    expect((await api(`/buyer/bounties/${id}/confirm`, { token: session.token, json: {} })).body.funded).toBe(true);
    expect((await api("/bounties")).body.bounties.map((b: any) => b.bounty_id)).toContain(id);
    expect((await api(`/buyer/bounties/${id}/confirm`, { token: buyer.token, json: {} })).status).toBe(404); // not their task
    expect((await api(`/buyer/bounties/${id}/fund-tx`, { token: session.token, json: {} })).status).toBe(409); // already funded
  });

  it("cleans up and says so if the funds can't be locked", async () => {
    const buyer = await signIn("b3@example.com");
    chain.openEscrow = async () => { throw new Error("rpc down"); };
    const r = await api("/buyer/bounties", { token: buyer.token, json: { title: "Doomed task", task_spec: "This one will not open, first-person.", per_episode_usdc: 10, min_episodes: 2 } });
    expect(r.status).toBe(502); expect(r.body.error).toMatch(/Nothing was posted/);
    expect((await api("/buyer/summary", { token: buyer.token })).body.bounties.some((b: any) => b.title === "Doomed task")).toBe(false);
  });

  it("shows what is locked, and lets the buyer take back the unspent funds only after the deadline", async () => {
    const buyer = await signIn("b4@example.com");
    const other = await signIn("b5@example.com");
    const made = (await api("/buyer/bounties", { token: buyer.token, json: { title: "Sweep floor", task_spec: "Sweep a small floor, first-person view.", per_episode_usdc: 10, min_episodes: 3 } })).body.bounty;
    const ref = { buyer: buyer.address, bountyId: made.bounty_id };
    const row = async () => (await api("/buyer/summary", { token: buyer.token })).body.bounties.find((b: any) => b.bounty_id === made.bounty_id);
    expect((await row()).escrow).toMatchObject({ funded: true, locked_usdc: 30, can_refund: false });

    expect((await api(`/buyer/bounties/${made.bounty_id}/refund`, { token: buyer.token, json: {} })).body.error).toMatch(/after the task's deadline/);
    expect((await api(`/buyer/bounties/${made.bounty_id}/refund`, { token: other.token, json: {} })).status).toBe(404);

    chain.vaults.get(`${ref.buyer}|${ref.bountyId}`)!.deadline = 1; // the deadline passes
    await new Promise((r) => setTimeout(r, 8_100)); // the summary's chain read is cached briefly
    expect((await row()).escrow.can_refund).toBe(true);
    const refund = await api(`/buyer/bounties/${made.bounty_id}/refund`, { token: buyer.token, json: {} });
    expect(refund.body.signature).toMatch(/^refund-/);
    expect(vault(made.bounty_id).vault).toBe(0);
    expect((await api(`/buyer/bounties/${made.bounty_id}/refund`, { token: buyer.token, json: {} })).body.error).toMatch(/nothing left/i);
  }, 20_000);

  // ---- contributors with their own wallet ----------------------------------------------------------------------
  const anchorReq = (over: Record<string, unknown> = {}) =>
    api("/anchor/tx", { json: { bounty_id: "bounty_004", episode_id: epId(), manifest_hash: "0x" + "cd".repeat(32), contributor: wallet(), ...over } });

  it("hands a wallet contributor a transaction to sign, and only for an open, funded task", async () => {
    const ok = await anchorReq();
    expect(ok.status).toBe(200); expect(typeof ok.body.tx).toBe("string");
    expect((await anchorReq({ bounty_id: "nope" })).status).toBe(409);
    expect((await anchorReq({ episode_id: "bad" })).status).toBe(400);
    expect((await anchorReq({ manifest_hash: "0x12" })).status).toBe(400);
    expect((await anchorReq({ contributor: "not-an-address" })).status).toBe(400);
  });

  it("caps how many unfinished takes one address can hold open", async () => {
    const who = wallet();
    for (let i = 0; i < 3; i++) expect((await anchorReq({ contributor: who })).status).toBe(200);
    expect((await anchorReq({ contributor: who })).status).toBe(429);
  });

  it("gives the same person a fresh transaction when they ask again for the same take, and nobody else", async () => {
    const who = wallet(); const id = epId(); const hash = "0x" + "cd".repeat(32);
    const first = await anchorReq({ episode_id: id, contributor: who, manifest_hash: hash });
    expect(first.status).toBe(200);
    // they cancelled in the wallet and tapped Approve again; at the cap, a retry must still work
    for (let i = 0; i < 2; i++) expect((await anchorReq({ contributor: who })).status).toBe(200);
    expect((await anchorReq({ contributor: who })).status).toBe(429); // a fourth take is over the cap...
    expect((await anchorReq({ episode_id: id, contributor: who, manifest_hash: hash })).status).toBe(200); // ...but the first can retry
    expect((await anchorReq({ episode_id: id, contributor: wallet(), manifest_hash: hash })).status).toBe(409); // someone else can't
    expect((await anchorReq({ episode_id: id, contributor: who, manifest_hash: "0x" + "ee".repeat(32) })).status).toBe(409); // a different take can't
  });

  it("won't issue a transaction for a take that has already been uploaded", async () => {
    const who = wallet(); const id = epId();
    const u = await upload("bounty_004", who, { id });
    await settled(u.id);
    expect((await anchorReq({ episode_id: id, contributor: who })).status).toBe(409);
  });

  it("frees reservations for transactions that were issued but never followed by an upload", async () => {
    const who = wallet(); const id = epId(); const hash = "0x" + "ef".repeat(32);
    expect((await anchorReq({ episode_id: id, contributor: who, manifest_hash: hash })).status).toBe(200);
    chain.walletSubmit(refOf("bounty_004"), id, hash, who); // the wallet signed and sent it, then the phone went away
    expect(vault("bounty_004").pending).toBe(1);
    expect(await server.sweepIssued(Date.now() + 5 * 60_000)).toBe(0); // too soon
    expect(await server.sweepIssued(Date.now() + 31 * 60_000)).toBe(1);
    expect(vault("bounty_004").pending).toBe(0);
    expect(chain.rejected).toContain(id);
  });

  it("leaves a transaction alone once its take was uploaded", async () => {
    const who = wallet(); const id = epId();
    const u = await upload("bounty_004", who, { id });
    await settled(u.id);
    expect(await server.sweepIssued(Date.now() + 60 * 60_000)).toBe(0);
  });

  it("anchors an email contributor's take server-side, in the buyer's escrow, and retries cleanly", async () => {
    const e = await signIn("c1@example.com");
    chain.failNextAnchor = true; // the first attempt fails; the take must not be paid, and nothing may be left reserved
    const first = await upload("bounty_004", e.address, { token: e.token });
    const v = await settled(first.id);
    expect(v.accepted).toBe(false);
    expect(vault("bounty_004").pending).toBe(0);
    expect(chain.payouts).toHaveLength(0);
    const second = await upload("bounty_004", e.address, { token: e.token });
    expect((await settled(second.id)).accepted).toBe(true);
    expect(chain.anchored).toHaveLength(1);
  });
});
