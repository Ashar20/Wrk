import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http";
import { Store } from "../src/store";
import { memoText, type ChainPort } from "../src/solana/chain";
import { Accounts } from "../src/accounts";
import type { Mailer } from "../src/mailer";
import { Keypair } from "@solana/web3.js";
import { sealManifest, sha256Hex } from "@/lib/manifest";
import type { Scores } from "@/lib/validator/score";

const CONTRIBUTOR = "9xQeWvG816bUx9EPfEZEoPqdNaE4gqCNTNqmbFnfZoxM";

function scores(percent: number | null, signature: string[] = ["a"]): Scores {
  return {
    framing: { percent: null, visibilityPercent: null },
    plausibility: { percent } as Scores["plausibility"],
    traces: [],
    signature,
    framesAnalyzed: 10,
    elapsedMs: 1,
  };
}

class CaptureMailer implements Mailer {
  codes: Record<string, string> = {};
  async sendCode(to: string, code: string) {
    this.codes[to] = code;
  }
}

class FakeChain implements ChainPort {
  cluster = "devnet";
  payouts: Array<{ contributor: string; amountUsdc: number }> = [];
  memos = new Set<string>();
  async verifyMemo(sig: string, e: { signer: string; memo: string }) {
    return this.memos.has(`${sig}|${e.signer}|${e.memo}`);
  }
  anchored: Array<{ memo: string; signer: string }> = [];
  async anchor(a: { signerSecret: Uint8Array; memo: string }) {
    const signer = Keypair.fromSecretKey(a.signerSecret).publicKey.toBase58();
    this.anchored.push({ memo: a.memo, signer });
    const sig = `anchor-sig-${this.anchored.length}`;
    this.memos.add(`${sig}|${signer}|${a.memo}`);
    return sig;
  }
  async pay(a: { contributor: string; amountUsdc: number }) {
    this.payouts.push(a);
    return `payout-sig-${this.payouts.length}`;
  }
}

async function makeEpisode(opts: { id?: string; tamper?: boolean; contributor?: string } = {}) {
  const rgb = new Uint8Array([1, 2, 3, 4, 5]);
  const imu = new Uint8Array([9, 8, 7]);
  const id = opts.id ?? "ep_" + "ab12".repeat(6);
  const manifest = await sealManifest({
    episode_id: id,
    schema_version: "0.2.0",
    bounty_id: "bounty_004",
    task: "cup_pick_and_place",
    contributor: opts.contributor ?? CONTRIBUTOR,
    duration_s: 15.2,
    recorded_at: 1757030400,
    capture: {
      video: { fps_nominal: 30, fps_observed: 29.5 },
      imu: { rate_hz_observed: 100 },
    },
    streams: {
      rgb: { sha256: await sha256Hex(rgb), bytes: rgb.length, content_type: "video/mp4" },
      imu: { sha256: await sha256Hex(imu), bytes: imu.length, content_type: "application/octet-stream" },
    },
  });
  if (opts.tamper) rgb[0] = 99;
  return { id, manifest, rgb, imu };
}

async function upload(base: string, ep: Awaited<ReturnType<typeof makeEpisode>>, anchor?: string, token?: string) {
  const form = new FormData();
  form.set("manifest", JSON.stringify(ep.manifest));
  form.set("rgb", new Blob([ep.rgb]), "rgb");
  form.set("imu", new Blob([ep.imu]), "imu");
  if (anchor) form.set("anchor_signature", anchor);
  return fetch(`${base}/episodes`, { method: "POST", body: form, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

async function settled(base: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await (await fetch(`${base}/episodes/${id}`)).json();
    if (r.status !== "scoring") return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("episode never settled");
}

describe("validator HTTP", () => {
  let base = "";
  let server: ReturnType<typeof createHttpServer>;
  let chain: FakeChain;
  let plausibility: number | null;
  let accounts: Accounts;
  let mailer: CaptureMailer;

  beforeEach(async () => {
    chain = new FakeChain();
    plausibility = 90;
    mailer = new CaptureMailer();
    accounts = new Accounts(mkdtempSync(join(tmpdir(), "wrk-acc-")), mailer);
    server = createHttpServer({
      store: new Store(mkdtempSync(join(tmpdir(), "wrk-test-"))),
      accounts,
      chain,
      score: async () => scores(plausibility),
      requireAnchor: true,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("does not leak acceptance thresholds in the bounty feed", async () => {
    const { bounties } = await (await fetch(`${base}/bounties`)).json();
    expect(bounties[0].bounty_id).toBe("bounty_004");
    expect(bounties[0].per_episode_usdc).toBe(0.6);
    expect(bounties[0]).not.toHaveProperty("min_plausibility");
  });

  it("accepts an anchored, plausible episode and pays exactly once", async () => {
    const ep = await makeEpisode();
    chain.memos.add(`sig1|${CONTRIBUTOR}|${memoText("bounty_004", ep.id, ep.manifest.manifest_hash)}`);
    expect((await upload(base, ep, "sig1")).status).toBe(202);
    const done = await settled(base, ep.id);
    expect(done.accepted).toBe(true);
    expect(done.payment.signature).toBe("payout-sig-1");
    expect(done.payment.amount_usdc).toBe(0.6);

    // Retried upload is idempotent: same record, no second payout.
    const again = await upload(base, ep, "sig1");
    expect(again.status).toBe(200);
    expect(chain.payouts).toHaveLength(1);
  });

  it("never pays a low-plausibility (replay) episode", async () => {
    plausibility = 11;
    const ep = await makeEpisode({ id: "ep_" + "cd34".repeat(6) });
    chain.memos.add(`sig2|${CONTRIBUTOR}|${memoText("bounty_004", ep.id, ep.manifest.manifest_hash)}`);
    await upload(base, ep, "sig2");
    const done = await settled(base, ep.id);
    expect(done.accepted).toBe(false);
    expect(done.reasons.join(" ")).toMatch(/Motion match/);
    expect(done.payment).toBeNull();
    expect(chain.payouts).toHaveLength(0);
  });

  it("does not pay when the memo is missing or wrong", async () => {
    const ep = await makeEpisode({ id: "ep_" + "ef56".repeat(6) });
    await upload(base, ep); // no anchor signature
    const done = await settled(base, ep.id);
    expect(done.accepted).toBe(false);
    expect(done.reasons.join(" ")).toMatch(/not found on Solana/);
    expect(chain.payouts).toHaveLength(0);
  });

  it("rejects tampered bytes at upload with 422", async () => {
    const ep = await makeEpisode({ id: "ep_" + "0a1b".repeat(6), tamper: true });
    const res = await upload(base, ep, "x");
    expect(res.status).toBe(422);
    expect((await res.json()).failures.join(" ")).toMatch(/stream/i);
  });

  it("marks an episode failed, not stuck, when scoring throws", async () => {
    server.close();
    const store = new Store(mkdtempSync(join(tmpdir(), "wrk-test-")));
    server = createHttpServer({ store, accounts, chain, score: async () => { throw new Error("no frames"); }, requireAnchor: true });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ep = await makeEpisode({ id: "ep_" + "9f8e".repeat(6) });
    await upload(base, ep, "s");
    const done = await settled(base, ep.id);
    expect(done.status).toBe("failed");
    expect(done.scoring_error).toBe("no frames");
    expect(chain.payouts).toHaveLength(0);
  });

  async function signIn(email: string) {
    await fetch(`${base}/auth/email/start`, { method: "POST", body: JSON.stringify({ email }) });
    const r = await fetch(`${base}/auth/email/verify`, { method: "POST", body: JSON.stringify({ email, code: mailer.codes[email.toLowerCase()] }) });
    return { status: r.status, ...(await r.json()) };
  }

  it("signs in by email, creating one payment account that is stable across sign-ins", async () => {
    const a = await signIn("Sam@Example.com");
    expect(a.status).toBe(200);
    expect(a.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const b = await signIn("sam@example.com");
    expect(b.address).toBe(a.address);
    expect(b.token).not.toBe(a.token);
    const me = await (await fetch(`${base}/me`, { headers: { authorization: `Bearer ${a.token}` } })).json();
    expect(me.address).toBe(a.address);
  });

  it("rejects wrong codes, locks after repeated guesses and refuses bad emails", async () => {
    await fetch(`${base}/auth/email/start`, { method: "POST", body: JSON.stringify({ email: "x@example.com" }) });
    const bad = () => fetch(`${base}/auth/email/verify`, { method: "POST", body: JSON.stringify({ email: "x@example.com", code: "000000" }) });
    for (let i = 0; i < 5; i++) expect((await bad()).status).toBe(400);
    expect((await bad()).status).toBe(429);
    expect((await fetch(`${base}/auth/email/start`, { method: "POST", body: JSON.stringify({ email: "nope" }) })).status).toBe(400);
    expect((await fetch(`${base}/me`)).status).toBe(401);
  });

  it("keeps the account key encrypted at rest and usable for signing", async () => {
    const a = await signIn("keys@example.com");
    const secret = accounts.secretFor("keys@example.com")!;
    expect(Keypair.fromSecretKey(secret).publicKey.toBase58()).toBe(a.address);
  });

  it("pays an email user with no wallet: the server anchors the memo for them", async () => {
    const a = await signIn("earn@example.com");
    const ep = await makeEpisode({ id: "ep_" + "77aa".repeat(6), contributor: a.address });
    expect((await upload(base, ep, undefined, a.token)).status).toBe(202);
    const done = await settled(base, ep.id);
    expect(done.accepted).toBe(true);
    expect(done.anchor.verified).toBe(true);
    expect(chain.anchored).toHaveLength(1);
    expect(chain.payouts).toHaveLength(1);
    expect(chain.payouts[0]).toMatchObject({ contributor: a.address, amountUsdc: 0.6 });
  });

  it("refuses to submit an episode as someone else's payment account", async () => {
    const a = await signIn("mine@example.com");
    const ep = await makeEpisode({ id: "ep_" + "88bb".repeat(6) }); // contributor = CONTRIBUTOR, not a.address
    expect((await upload(base, ep, undefined, a.token)).status).toBe(403);
    expect(chain.payouts).toHaveLength(0);
  });

  it("rejects an expired session instead of treating the upload as anonymous", async () => {
    const ep = await makeEpisode({ id: "ep_" + "99cc".repeat(6) });
    expect((await upload(base, ep, "s", "bogus-token")).status).toBe(401);
  });
});
