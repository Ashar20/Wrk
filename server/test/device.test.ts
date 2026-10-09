import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Accounts } from "../src/accounts";
import { Devices, MAX_ACCOUNTS_PER_DEVICE, UNATTESTED_DAILY_CAP } from "../src/attestation/devices";
import { BountyStore } from "../src/bountyStore";
import { createHttpServer } from "../src/http";
import type { Mailer } from "../src/mailer";
import { Store } from "../src/store";
import { sealManifest, sha256Hex } from "@/lib/manifest";
import type { Scores } from "@/lib/validator/score";
import { FakeChain } from "./fakeChain";
import { makeAuthority, makeChain, signWith, type Authority, type Chain } from "./attestationFixture";

const DIGEST = "ab".repeat(32);

const scores = (): Scores => ({
  framing: { verdict: "ok", percent: 80, framesAnalyzed: 10, framesWithHands: 9, framesInGuide: 8, visibilityPercent: 90 },
  plausibility: { percent: 85 } as Scores["plausibility"], traces: [], signature: [randomBytes(8).toString("hex")], framesAnalyzed: 10, elapsedMs: 1,
});

class CaptureMailer implements Mailer {
  codes: Record<string, string> = {};
  async sendCode(to: string, code: string) { this.codes[to] = code; }
}

describe("devices: registration and limits", () => {
  let base = ""; let server: ReturnType<typeof createHttpServer>;
  let chain: FakeChain; let bounties: BountyStore; let devices: Devices; let authority: Authority; let mailer: CaptureMailer; let n = 0;
  let requireDevice = false;
  /** Scoring waits on this, so a test can submit many takes before any is decided. */
  let hold: Promise<void> = Promise.resolve();

  const build = async () => {
    bounties = new BountyStore(mkdtempSync(join(tmpdir(), "wrk-b-")));
    await chain.seed(bounties);
    devices = new Devices(mkdtempSync(join(tmpdir(), "wrk-d-")), { roots: [authority.rootPem], allowedAppCerts: [DIGEST] });
    server = createHttpServer({
      store: new Store(mkdtempSync(join(tmpdir(), "wrk-e-"))), accounts: new Accounts(mkdtempSync(join(tmpdir(), "wrk-a-")), mailer), bounties, chain, devices,
      requireDevice, score: async () => { await hold; return scores(); }, requireAnchor: true,
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeEach(async () => { hold = Promise.resolve(); chain = new FakeChain(); mailer = new CaptureMailer(); authority = await makeAuthority(); n = 0; requireDevice = false; await build(); });
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

  interface Phone { id: string; chain: Chain; trust: string }
  /** A phone registering: it asks for a challenge, makes a key with it, and sends the certificate chain. */
  async function phone(opts: Partial<Parameters<typeof makeChain>[0]> = {}): Promise<Phone> {
    const c = (await api("/device/challenge")).body.challenge as string;
    const ch = await makeChain({ challenge: Buffer.from(c, "base64"), digest: DIGEST, ...opts }, authority);
    const r = await api("/device/register", { json: { challenge: c, chain: ch.der.map((d) => d.toString("base64")) } });
    expect(r.status).toBe(200);
    return { id: r.body.device_id, chain: ch, trust: r.body.trust };
  }

  const wallet = () => Keypair.generate().publicKey.toBase58();
  const refOf = (b: string) => ({ buyer: bounties.get(b)!.escrow!.buyer, bountyId: b });

  async function upload(bountyId: string, contributor: string, opts: { phone?: Phone; signAs?: Phone; badSignature?: boolean; deviceId?: string } = {}) {
    const rgb = new Uint8Array(Array.from({ length: 400 }, (_, i) => (i + n) % 251)); const imu = new Uint8Array([9, 8, 7]);
    const id = "ep_" + (++n).toString(16).padStart(4, "0").repeat(6);
    const manifest = await sealManifest({
      episode_id: id, schema_version: "0.2.0", bounty_id: bountyId, task: "t", contributor, duration_s: 15, recorded_at: 1757030400,
      capture: { video: { fps_nominal: 30, fps_observed: 29.5 }, imu: { rate_hz_observed: 100 } },
      streams: { rgb: { sha256: await sha256Hex(rgb), bytes: 400, content_type: "video/mp4" }, imu: { sha256: await sha256Hex(imu), bytes: 3, content_type: "application/octet-stream" } },
    });
    chain.walletSubmit(refOf(bountyId), id, manifest.manifest_hash, contributor);
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest)); form.set("rgb", new Blob([rgb])); form.set("imu", new Blob([imu]));
    const p = opts.phone;
    if (p || opts.deviceId) {
      form.set("device_id", opts.deviceId ?? p!.id);
      const signer = opts.signAs ?? p!;
      const sig = opts.badSignature ? Buffer.from("garbage") : await signWith(signer.chain.leafPrivateKey, `wrk:take:v1:${id}:${manifest.manifest_hash}`);
      form.set("device_signature", sig.toString("base64"));
    }
    const res = await fetch(`${base}/episodes`, { method: "POST", body: form });
    const text = await res.text(); let body: any = text; try { body = JSON.parse(text); } catch { /* */ }
    return { id, status: res.status, body };
  }
  const settled = async (id: string) => {
    for (let i = 0; i < 100; i++) { const v = (await api(`/episodes/${id}`)).body; if (v.status !== "scoring") return v; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error("never settled");
  };

  // ---- registration --------------------------------------------------------------------------------------------
  it("registers a genuine phone as attested", async () => {
    const p = await phone();
    expect(p.trust).toBe("attested");
    expect(devices.get(p.id)).toMatchObject({ level: "tee", boot_verified: true, app_verified: true, fully_attested: true });
  });

  it("registers a phone running an unverified OS, but only as heuristic", async () => {
    const p = await phone({ boot: { locked: false, state: 2 } });
    expect(p.trust).toBe("heuristic");
  });

  it("refuses a registration made for someone else's challenge, a second use of a challenge, and the wrong app", async () => {
    const c1 = (await api("/device/challenge")).body.challenge as string;
    const c2 = (await api("/device/challenge")).body.challenge as string;
    const chain1 = await makeChain({ challenge: Buffer.from(c1, "base64"), digest: DIGEST }, authority);
    const send = (challenge: string, ch: Chain) => api("/device/register", { json: { challenge, chain: ch.der.map((d) => d.toString("base64")) } });
    expect((await send(c2, chain1)).body.failures.join(" ")).toMatch(/wasn't made for this request/); // made for c1, presented for c2
    expect((await send(c2, chain1)).body.error).toMatch(/expired/); // c2 is now spent
    expect((await send("bm90LWEtY2hhbGxlbmdl", chain1)).status).toBe(400); // never issued

    const c3 = (await api("/device/challenge")).body.challenge as string;
    const evil = await makeChain({ challenge: Buffer.from(c3, "base64"), digest: DIGEST, pkg: "com.evil.app" }, authority);
    expect((await send(c3, evil)).body.failures.join(" ")).toMatch(/Wrk app/);
  });

  it("refuses a chain that doesn't lead to a trusted root", async () => {
    const c = (await api("/device/challenge")).body.challenge as string;
    const stranger = await makeChain({ challenge: Buffer.from(c, "base64"), digest: DIGEST }); // its own, untrusted, authority
    const r = await api("/device/register", { json: { challenge: c, chain: stranger.der.map((d) => d.toString("base64")) } });
    expect(r.status).toBe(400); expect(r.body.failures.join(" ")).toMatch(/trusted Google root/);
  });

  // ---- takes -----------------------------------------------------------------------------------------------------
  it("marks a take attested only when the verified phone's key signed it", async () => {
    const p = await phone();
    const u = await upload("bounty_004", wallet(), { phone: p });
    expect(u.status).toBe(202);
    expect(u.body.trust_level).toBe("attested");
    expect((await settled(u.id)).trust_level).toBe("attested");
    const plain = await upload("bounty_004", wallet());
    expect((await settled(plain.id)).trust_level).toBe("heuristic");
  });

  it("refuses takes with a forged signature, another phone's signature, or an unknown device", async () => {
    const mine = await phone(); const other = await phone();
    expect((await upload("bounty_004", wallet(), { phone: mine, badSignature: true })).status).toBe(400);
    expect((await upload("bounty_004", wallet(), { phone: mine, signAs: other })).status).toBe(400);
    const unknown = await upload("bounty_004", wallet(), { phone: mine, deviceId: "f".repeat(32) });
    expect(unknown.status).toBe(400); expect(unknown.body.error).toMatch(/isn't registered/);
  });

  it("keeps tasks that need verified phones closed to everyone else", async () => {
    const buyer = await (async () => {
      await api("/auth/email/start", { json: { email: "pickyb@example.com" } });
      return (await api("/auth/email/verify", { json: { email: "pickyb@example.com", code: mailer.codes["pickyb@example.com"] } })).body;
    })();
    const made = (await api("/buyer/bounties", { token: buyer.token, json: { title: "Verified only", task_spec: "Do the thing, first-person view.", per_episode_usdc: 1, min_episodes: 5, min_trust_level: "attested" } })).body.bounty;
    expect(made.min_trust_level).toBe("attested");
    expect((await upload(made.bounty_id, wallet())).status).toBe(403);
    expect((await upload(made.bounty_id, wallet(), { phone: await phone({ boot: { locked: false, state: 2 } }) })).status).toBe(403);
    expect((await upload(made.bounty_id, wallet(), { phone: await phone() })).status).toBe(202);
  });

  it("can require a verified phone for everything", async () => {
    server.close(); requireDevice = true; await build();
    expect((await upload("bounty_004", wallet())).status).toBe(403);
    expect((await upload("bounty_004", wallet(), { phone: await phone() })).status).toBe(202);
  });

  // ---- limits ----------------------------------------------------------------------------------------------------
  it("limits a payment account with no verified phone to a few takes a day", async () => {
    const who = wallet();
    for (let i = 0; i < UNATTESTED_DAILY_CAP; i++) expect((await upload("bounty_004", who)).status).toBe(202);
    const over = await upload("bounty_004", who);
    expect(over.status).toBe(403); expect(over.body.error).toMatch(/limit of 5/);
    expect((await upload("bounty_004", wallet())).status).toBe(202); // a different account has its own allowance
  });

  it("gives a verified phone a bigger allowance, shared by every account used on it", async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; }); // nothing is decided while we submit, so the allowance stays at its start
    const p = await phone();
    const people = [wallet(), wallet(), wallet()]; // up to three accounts per phone is fine (a household)
    for (let i = 0; i < 20; i++) expect((await upload("bounty_004", people[i % 3], { phone: p })).status).toBe(202);
    const over = await upload("bounty_004", people[0], { phone: p });
    expect(over.status).toBe(403); expect(over.body.error).toMatch(/limit of 20/);
    release();
  }, 30_000);

  it("treats many accounts on one phone as farming and clamps it", async () => {
    const p = await phone();
    for (let a = 0; a < MAX_ACCOUNTS_PER_DEVICE; a++) {
      const w = wallet();
      expect((await upload("bounty_004", w, { phone: p })).status).toBe(202);
      expect((await upload("bounty_004", w, { phone: p })).status).toBe(202);
    }
    // six takes so far; a fourth account on the same phone drops the whole phone to the small cap
    const fourth = await upload("bounty_004", wallet(), { phone: p });
    expect(fourth.status).toBe(403); expect(fourth.body.error).toMatch(/Too many accounts/);
  });

  it("lets a phone's allowance grow as its takes get accepted", () => {
    const d = new Devices(mkdtempSync(join(tmpdir(), "wrk-d-")), { roots: [], allowedAppCerts: [DIGEST] });
    (d as any).devices["x"] = { id: "x", fully_attested: true, accepted: 0, rejected: 0, accounts: [], days: {} };
    expect(d.allowance("x", "a").cap).toBe(20);
    for (let i = 0; i < 5; i++) d.decided("x", true);
    expect(d.allowance("x", "a").cap).toBe(30);
    for (let i = 0; i < 200; i++) d.decided("x", true);
    expect(d.allowance("x", "a").cap).toBe(100); // never unbounded
    // a refusal costs more than an acceptance earns, and a bad run bottoms out at the unverified allowance
    (d as any).devices["y"] = { id: "y", fully_attested: true, accepted: 5, rejected: 0, accounts: [], days: {} };
    d.decided("y", false);
    expect(d.get("y")!.rejected).toBe(1);
    expect(d.allowance("y", "a").cap).toBe(27);
    for (let i = 0; i < 100; i++) d.decided("y", false);
    expect(d.allowance("y", "a").cap).toBe(UNATTESTED_DAILY_CAP);
  });

  it("feeds the standing of a phone back from the verdicts on its takes", async () => {
    const p = await phone();
    const u = await upload("bounty_004", wallet(), { phone: p });
    await settled(u.id);
    expect(devices.get(p.id)!.accepted).toBe(1);
  });

  // ---- housekeeping ----------------------------------------------------------------------------------------------
  it("challenges are single-use and expire", () => {
    let t = 1_000_000;
    const d = new Devices(mkdtempSync(join(tmpdir(), "wrk-d-")), { roots: [], now: () => t });
    const { challenge } = d.challenge();
    t += 6 * 60_000;
    expect(() => d.register(challenge, [])).toThrow(/expired/);
    expect(() => d.register(challenge, [])).toThrow(/expired/);
  });

  it("remembers phones across restarts", async () => {
    const p = await phone();
    const dir = (devices as any).file.replace(/\/devices\.json$/, "");
    const again = new Devices(dir, { roots: [authority.rootPem] });
    expect(again.get(p.id)?.fully_attested).toBe(true);
  });
});
