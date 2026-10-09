import { X509Certificate, createHash, timingSafeEqual } from "node:crypto";
import { UNIVERSAL, children, readTlv, toBool, toInt, type Tlv } from "./der";
import googleRoots from "./google-roots.json";

/** OID 1.3.6.1.4.1.11129.2.1.17: the Android key attestation extension. */
const ATTESTATION_OID = Buffer.from("2b06010401d679020111", "hex");

const SECURITY_LEVEL = ["software", "tee", "strongbox"] as const;
export type SecurityLevel = (typeof SECURITY_LEVEL)[number];

// KeyMint authorization-list tags we read.
const TAG = { purpose: 1, algorithm: 2, origin: 702, rootOfTrust: 704, appId: 709 } as const;
const PURPOSE_SIGN = 2;
const ALGORITHM_EC = 3;
const ORIGIN_GENERATED = 0;
const BOOT_VERIFIED = 0;

export interface AttestationOptions {
  /** The random challenge the server issued; the key must have been created with exactly it. */
  challenge: Buffer;
  /** Trusted roots, PEM. Defaults to Google's published hardware attestation roots. */
  roots?: string[];
  /** SHA-256 digests (hex) of Wrk's signing certificates. Empty means the app's identity is not checked. */
  allowedAppCerts?: string[];
  packageName: string;
  /** Revoked certificate serials (decimal or hex strings), when known. */
  revoked?: ReadonlySet<string>;
}

export interface AttestationResult {
  /** The chain, challenge and key properties all check out. */
  ok: boolean;
  failures: string[];
  level: SecurityLevel;
  /** Bootloader locked and the OS verified at boot. */
  bootVerified: boolean;
  /** The app that made the key is Wrk, signed by Wrk's certificate. False when no allowlist is configured. */
  appVerified: boolean;
  appPackage: string | null;
  appCertDigests: string[];
  /** The attested public key, SPKI DER. */
  spki: Buffer | null;
}

/** Which of the certificate's extensions holds the key description? Parses just enough of an X.509 certificate. */
function keyDescription(cert: X509Certificate): Buffer | null {
  const certTlv = readTlv(cert.raw).tlv; // Certificate ::= SEQUENCE { tbsCertificate, ... }
  const tbs = children(certTlv.value)[0];
  const extensionsWrapper = children(tbs.value).find((c) => c.cls === 2 && c.tag === 3); // [3] EXPLICIT Extensions
  if (!extensionsWrapper) return null;
  const extensions = children(readTlv(extensionsWrapper.value).tlv.value);
  for (const ext of extensions) {
    const parts = children(ext.value); // OID, [critical BOOLEAN], extnValue OCTET STRING
    if (parts[0]?.value.equals(ATTESTATION_OID)) return parts[parts.length - 1].value;
  }
  return null;
}

/** An AuthorizationList is a SEQUENCE of EXPLICIT context-tagged fields. Returns each field's inner value by tag number. */
function authList(t: Tlv): Map<number, Tlv> {
  const out = new Map<number, Tlv>();
  for (const f of children(t.value)) {
    if (f.cls === 2 && f.value.length > 0) out.set(f.tag, readTlv(f.value).tlv);
  }
  return out;
}

const level = (t: Tlv): SecurityLevel => SECURITY_LEVEL[toInt(t)] ?? "software";

function parseAppId(octets: Tlv): { pkg: string | null; digests: string[] } {
  const seq = readTlv(octets.value).tlv; // SEQUENCE { SET packageInfos, SET signatureDigests }
  const [packages, digests] = children(seq.value);
  const first = packages ? children(packages.value)[0] : undefined;
  const pkg = first ? children(first.value)[0]?.value.toString("utf8") ?? null : null;
  return { pkg, digests: digests ? children(digests.value).map((d) => d.value.toString("hex")) : [] };
}

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Verifies an Android hardware key attestation: the certificate chain leads to a Google root, the key was made on
 * a real device's secure hardware with our challenge, for signing, by our app, and the OS booted verified.
 * What it proves is device and app provenance for the key; it says nothing about what the camera saw.
 */
export function verifyAttestation(chainDer: Buffer[], o: AttestationOptions): AttestationResult {
  const failures: string[] = [];
  const bad: AttestationResult = { ok: false, failures, level: "software", bootVerified: false, appVerified: false, appPackage: null, appCertDigests: [], spki: null };
  const fail = (m: string) => { failures.push(m); return bad; };

  if (chainDer.length < 2) return fail("The attestation chain is too short.");
  let chain: X509Certificate[];
  try { chain = chainDer.map((d) => new X509Certificate(d)); } catch { return fail("The attestation chain isn't made of valid certificates."); }

  // Each certificate is signed by the next, and the last is (or is signed by) a Google root.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].verify(chain[i + 1].publicKey)) return fail("The attestation chain's signatures don't link up.");
  }
  const roots = (o.roots ?? (googleRoots as string[])).map((p) => new X509Certificate(p));
  const last = chain[chain.length - 1];
  if (!roots.some((r) => r.raw.equals(last.raw) || last.verify(r.publicKey))) return fail("The attestation doesn't lead to a trusted Google root.");

  if (o.revoked) {
    for (const c of chain) {
      const hex = c.serialNumber.toLowerCase().replace(/^0+/, "");
      if (o.revoked.has(hex) || o.revoked.has(BigInt("0x" + (hex || "0")).toString())) return fail("A certificate in the chain has been revoked.");
    }
  }

  const leaf = chain[0];
  const raw = keyDescription(leaf);
  if (!raw) return fail("The certificate carries no key attestation.");

  let kd: Tlv[];
  try { kd = children(readTlv(raw).tlv.value); } catch { return fail("The key attestation couldn't be read."); }
  // [version, attestationSecurityLevel, keyMintVersion, keyMintSecurityLevel, challenge, uniqueId, softwareEnforced, hardwareEnforced]
  if (kd.length < 8) return fail("The key attestation is incomplete.");

  const attLevel = level(kd[1]);
  const keyLevel = level(kd[3]);
  const hw = SECURITY_LEVEL.indexOf(attLevel) >= 1 && SECURITY_LEVEL.indexOf(keyLevel) >= 1;
  if (!same(kd[4].value, o.challenge)) failures.push("The attestation wasn't made for this request.");
  if (!hw) failures.push("The key isn't held in the device's secure hardware.");

  const software = authList(kd[6]);
  const hardware = authList(kd[7]);
  const get = (tag: number) => hardware.get(tag) ?? software.get(tag);

  const purposes = get(TAG.purpose) ? children(get(TAG.purpose)!.value).map(toInt) : [];
  if (!purposes.includes(PURPOSE_SIGN)) failures.push("The key can't sign.");
  const algorithm = get(TAG.algorithm);
  if (!algorithm || toInt(algorithm) !== ALGORITHM_EC) failures.push("The key isn't an elliptic-curve key.");
  const origin = get(TAG.origin);
  if (!origin || toInt(origin) !== ORIGIN_GENERATED) failures.push("The key wasn't generated on the device.");

  let bootVerified = false;
  const rot = get(TAG.rootOfTrust);
  if (rot) {
    const [, locked, state] = children(rot.value); // verifiedBootKey, deviceLocked, verifiedBootState, ...
    bootVerified = !!locked && toBool(locked) && !!state && toInt(state) === BOOT_VERIFIED;
  }

  let appPackage: string | null = null;
  let digests: string[] = [];
  const appId = get(TAG.appId);
  if (appId) {
    try { ({ pkg: appPackage, digests } = parseAppId(appId)); } catch { failures.push("The app identity couldn't be read."); }
  }
  if (appPackage !== o.packageName) failures.push("The key wasn't made by the Wrk app.");

  const allowed = (o.allowedAppCerts ?? []).map((d) => d.toLowerCase().replace(/[^0-9a-f]/g, ""));
  const appVerified = appPackage === o.packageName && allowed.length > 0 && digests.some((d) => allowed.includes(d));

  return {
    ok: failures.length === 0,
    failures,
    level: attLevel,
    bootVerified,
    appVerified,
    appPackage,
    appCertDigests: digests,
    spki: leaf.publicKey.export({ type: "spki", format: "der" }) as Buffer,
  };
}

/** Is this result strong enough to call a take "attested"? */
export const isFullyAttested = (r: AttestationResult) => r.ok && r.level !== "software" && r.bootVerified && r.appVerified;

export const deviceIdOf = (spki: Buffer) => createHash("sha256").update(spki).digest("hex").slice(0, 32);

/** Google's published revocation list: serial numbers of attestation certificates that must not be trusted. */
export async function fetchRevocations(fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
  const res = await fetchImpl("https://android.googleapis.com/attestation/status", { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const j = (await res.json()) as { entries?: Record<string, unknown> };
  return new Set(Object.keys(j.entries ?? {}).map((k) => k.toLowerCase().replace(/^0+/, "")));
}

export { UNIVERSAL };
