import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deviceIdOf, isFullyAttested, verifyAttestation } from "../src/attestation/android";
import { children, readTlv } from "../src/attestation/der";
import { makeChain, type KeyOpts } from "./attestationFixture";

const DIGEST = "ab".repeat(32);
const challenge = () => randomBytes(32);

async function check(over: Partial<KeyOpts> & { omitExtension?: boolean; omitRoot?: boolean } = {}, opts: { challenge?: Buffer; allowed?: string[]; revoked?: Set<string> } = {}) {
  const c = challenge();
  const chain = await makeChain({ challenge: c, digest: DIGEST, ...over });
  const result = verifyAttestation(chain.der, {
    challenge: opts.challenge ?? c, roots: [chain.rootPem], packageName: "com.wrk.app",
    allowedAppCerts: opts.allowed ?? [DIGEST], revoked: opts.revoked,
  });
  return { chain, result };
}

describe("DER reader", () => {
  it("reads high tag numbers the way KeyMint writes them", () => {
    const { tlv } = readTlv(Buffer.from("bf8540" + "03" + "020101", "hex")); // [704] containing INTEGER 1
    expect(tlv).toMatchObject({ cls: 2, constructed: true, tag: 704 });
    expect(children(tlv.value)[0].tag).toBe(2);
  });
  it("refuses data that lies about its length", () => {
    expect(() => readTlv(Buffer.from("3005020101", "hex"))).toThrow();
    expect(() => readTlv(Buffer.from("", "hex"))).toThrow();
    expect(() => readTlv(Buffer.from("30", "hex"))).toThrow();
  });
});

describe("Android key attestation", () => {
  it("accepts a genuine hardware key made by the Wrk app on a verified device", async () => {
    const { chain, result } = await check();
    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ ok: true, level: "tee", bootVerified: true, appVerified: true, appPackage: "com.wrk.app" });
    expect(result.appCertDigests).toEqual([DIGEST]);
    expect(result.spki!.equals(chain.leafSpki)).toBe(true);
    expect(isFullyAttested(result)).toBe(true);
    expect(deviceIdOf(result.spki!)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("recognises StrongBox", async () => {
    expect((await check({ attLevel: 2, keyLevel: 2 })).result.level).toBe("strongbox");
  });

  it("rejects an attestation made for a different request (a replayed registration)", async () => {
    const { result } = await check({}, { challenge: randomBytes(32) });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/wasn't made for this request/);
  });

  it("rejects software-only keys", async () => {
    const { result } = await check({ attLevel: 0, keyLevel: 0 });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/secure hardware/);
    expect(isFullyAttested(result)).toBe(false);
  });

  it("accepts the key but won't call it fully attested on an unlocked or unverified device", async () => {
    for (const boot of [{ locked: false, state: 0 }, { locked: true, state: 2 }, { locked: true, state: 3 }, null]) {
      const { result } = await check({ boot });
      expect(result.ok).toBe(true);
      expect(result.bootVerified).toBe(false);
      expect(isFullyAttested(result)).toBe(false);
    }
  });

  it("rejects a key made by some other app", async () => {
    const { result } = await check({ pkg: "com.evil.app" });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/by the Wrk app/);
  });

  it("only vouches for the app when it's signed with Wrk's certificate", async () => {
    expect((await check({}, { allowed: ["cd".repeat(32)] })).result.appVerified).toBe(false);
    expect((await check({}, { allowed: [] })).result.appVerified).toBe(false); // nothing configured: identity unchecked
    expect(isFullyAttested((await check({}, { allowed: ["cd".repeat(32)] })).result)).toBe(false);
    expect((await check({}, { allowed: [DIGEST.toUpperCase()] })).result.appVerified).toBe(true); // case and separators don't matter
  });

  it("rejects keys that can't sign, aren't EC, or were imported rather than generated", async () => {
    expect((await check({ purposes: [3] })).result.failures.join(" ")).toMatch(/can't sign/);
    expect((await check({ algorithm: 1 })).result.failures.join(" ")).toMatch(/elliptic/);
    expect((await check({ origin: 2 })).result.failures.join(" ")).toMatch(/generated on the device/);
  });

  it("rejects a chain that doesn't lead to a trusted root", async () => {
    const c = challenge();
    const chain = await makeChain({ challenge: c, digest: DIGEST });
    const other = await makeChain({ challenge: c, digest: DIGEST });
    const r = verifyAttestation(chain.der, { challenge: c, roots: [other.rootPem], packageName: "com.wrk.app", allowedAppCerts: [DIGEST] });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/trusted Google root/);
  });

  it("rejects a chain whose links don't verify (a spliced intermediate)", async () => {
    const c = challenge();
    const a = await makeChain({ challenge: c, digest: DIGEST });
    const b = await makeChain({ challenge: c, digest: DIGEST });
    const spliced = [a.der[0], b.der[1], a.der[2]];
    const r = verifyAttestation(spliced, { challenge: c, roots: [a.rootPem], packageName: "com.wrk.app", allowedAppCerts: [DIGEST] });
    expect(r.ok).toBe(false);
  });

  it("works when the phone leaves the root off the chain", async () => {
    const { result } = await check({ omitRoot: true });
    expect(result.ok).toBe(true);
  });

  it("rejects a leaf without an attestation, short chains and garbage without throwing", async () => {
    expect((await check({ omitExtension: true })).result.failures.join(" ")).toMatch(/no key attestation/);
    const c = challenge();
    const chain = await makeChain({ challenge: c });
    const o = { challenge: c, roots: [chain.rootPem], packageName: "com.wrk.app" };
    expect(verifyAttestation([chain.der[0]], o).ok).toBe(false);
    expect(verifyAttestation([], o).ok).toBe(false);
    expect(verifyAttestation([Buffer.from("not a certificate"), Buffer.from("nor this")], o).ok).toBe(false);
  });

  it("rejects revoked certificates, whether the list uses hex or decimal serials", async () => {
    const first = await check();
    const serialHex = first.chain.serials[0].toLowerCase().replace(/^0+/, "");
    const c = challenge();
    const chain = await makeChain({ challenge: c, digest: DIGEST });
    const hex = chain.serials[1].toLowerCase().replace(/^0+/, "");
    for (const entry of [hex, BigInt("0x" + hex).toString()]) {
      const r = verifyAttestation(chain.der, { challenge: c, roots: [chain.rootPem], packageName: "com.wrk.app", allowedAppCerts: [DIGEST], revoked: new Set([entry]) });
      expect(r.ok).toBe(false);
      expect(r.failures.join(" ")).toMatch(/revoked/);
    }
    expect(serialHex.length).toBeGreaterThan(0);
  });
});
