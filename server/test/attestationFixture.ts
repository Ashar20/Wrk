import "reflect-metadata";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

// ---- tiny DER builders ----------------------------------------------------------------------------------------------
const len = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
export const tlv = (tag: number, v: Buffer | number[]) => { const b = Buffer.from(v); return Buffer.concat([Buffer.from([tag, ...len(b.length)]), b]); };
export const int = (n: number) => tlv(0x02, n === 0 ? [0] : [n]);
export const enumerated = (n: number) => tlv(0x0a, [n]);
export const octets = (b: Buffer | string) => tlv(0x04, Buffer.isBuffer(b) ? b : Buffer.from(b));
export const seq = (...p: Buffer[]) => tlv(0x30, Buffer.concat(p));
export const set = (...p: Buffer[]) => tlv(0x31, Buffer.concat(p));
export const bool = (v: boolean) => tlv(0x01, [v ? 0xff : 0]);

/** EXPLICIT [n] wrapper; numbers above 30 use the multi-byte tag form, as KeyMint's do (704, 709, ...). */
export function ctx(n: number, inner: Buffer) {
  if (n < 31) return tlv(0xa0 | n, inner);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 7) bytes.unshift((x & 0x7f) | (bytes.length ? 0x80 : 0));
  bytes[bytes.length - 1] &= 0x7f;
  return Buffer.concat([Buffer.from([0xbf, ...bytes, ...len(inner.length)]), inner]);
}

export interface KeyOpts {
  challenge: Buffer;
  attLevel?: number; // 0 software, 1 TEE, 2 StrongBox
  keyLevel?: number;
  purposes?: number[];
  algorithm?: number;
  origin?: number;
  boot?: { locked: boolean; state: number } | null;
  pkg?: string;
  digest?: string; // hex SHA-256 of the signing certificate
}

export function keyDescription(o: KeyOpts) {
  const purposes = o.purposes ?? [2];
  const hardware = seq(
    ctx(1, set(...purposes.map(int))),
    ctx(2, int(o.algorithm ?? 3)),
    ...(o.boot === null ? [] : [ctx(704, seq(octets("bootkey"), bool((o.boot ?? { locked: true }).locked), enumerated((o.boot ?? { state: 0 }).state), octets("bootHash")))]),
    ctx(702, int(o.origin ?? 0)),
  );
  const software = seq(
    ctx(709, octets(seq(set(seq(octets(o.pkg ?? "com.wrk.app"), int(1))), set(octets(Buffer.from(o.digest ?? "aa".repeat(32), "hex")))))),
  );
  return seq(int(4), enumerated(o.attLevel ?? 1), int(41), enumerated(o.keyLevel ?? 1), octets(o.challenge), octets(""), software, hardware);
}

// ---- certificates ---------------------------------------------------------------------------------------------------
const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const ATTESTATION_OID = "1.3.6.1.4.1.11129.2.1.17";

async function keys() {
  return webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

async function ca(name: string, signer?: { cert: x509.X509Certificate; key: CryptoKey }) {
  const k = await keys();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString("hex"),
    subject: `CN=${name}`, issuer: signer ? signer.cert.subject : `CN=${name}`,
    notBefore: new Date(Date.now() - 86_400_000), notAfter: new Date(Date.now() + 10 * 86_400_000),
    signingAlgorithm: alg, publicKey: k.publicKey, signingKey: signer ? signer.key : k.privateKey,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return { cert, key: k.privateKey };
}

export interface Chain {
  /** Leaf first, root last, as the phone sends it. */
  der: Buffer[];
  rootPem: string;
  leafPrivateKey: CryptoKey;
  leafSpki: Buffer;
  serials: string[];
}

export interface Authority {
  root: Awaited<ReturnType<typeof ca>>;
  inter: Awaited<ReturnType<typeof ca>>;
  rootPem: string;
}

/** A stand-in for Google's attestation root, so many phones can share one trusted root in a test. */
export async function makeAuthority(): Promise<Authority> {
  const root = await ca("Fake Attestation Root");
  const inter = await ca("Fake Attestation Intermediate", root);
  return { root, inter, rootPem: root.cert.toString("pem") };
}

export async function makeChain(o: KeyOpts & { omitExtension?: boolean; omitRoot?: boolean }, authority?: Authority): Promise<Chain> {
  const { root, inter } = authority ?? (await makeAuthority());
  const lk = await keys();
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString("hex"),
    subject: "CN=Android Keystore Key", issuer: inter.cert.subject,
    notBefore: new Date(Date.now() - 86_400_000), notAfter: new Date(Date.now() + 10 * 86_400_000),
    signingAlgorithm: alg, publicKey: lk.publicKey, signingKey: inter.key,
    extensions: o.omitExtension ? [] : [new x509.Extension(ATTESTATION_OID, false, new Uint8Array(keyDescription(o)))],
  });
  const certs = [leaf, inter.cert, ...(o.omitRoot ? [] : [root.cert])];
  return {
    der: certs.map((c) => Buffer.from(c.rawData)),
    rootPem: root.cert.toString("pem"),
    leafPrivateKey: lk.privateKey,
    leafSpki: Buffer.from(await webcrypto.subtle.exportKey("spki", lk.publicKey)),
    serials: certs.map((c) => c.serialNumber),
  };
}

/** What the phone does: sign a message with the attested key. Returns a DER ECDSA signature. */
export async function signWith(key: CryptoKey, message: string) {
  const raw = Buffer.from(await webcrypto.subtle.sign(alg, key, Buffer.from(message)));
  // WebCrypto returns r||s; Android (and Node's default) use DER.
  const half = raw.length / 2;
  const enc = (b: Buffer) => { let x = b; while (x.length > 1 && x[0] === 0) x = x.subarray(1); return x[0] & 0x80 ? Buffer.concat([Buffer.from([0]), x]) : x; };
  return seq(tlv(0x02, enc(raw.subarray(0, half))), tlv(0x02, enc(raw.subarray(half))));
}
