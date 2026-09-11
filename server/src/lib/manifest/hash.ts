/**
 * Manifest hashing — the commitment that approach C is built on.
 *
 * The phone computes this BEFORE any byte leaves the device, signs it, and
 * only then uploads. The API route recomputes it from what actually arrived.
 * Both sides call this same function.
 *
 * See docs/superpowers/specs/2026-08-23-contributor-pwa-design.md §4.
 */

import { canonicalBytes, type JsonValue } from "./canonicalize";

/** The field a sealed manifest carries, excluded from its own preimage. */
export const HASH_FIELD = "manifest_hash";

export type Manifest = { [key: string]: JsonValue };
export type SealedManifest = Manifest & { [HASH_FIELD]: string };

/**
 * WebCrypto is used rather than node:crypto so that one implementation runs
 * unmodified in the browser worker and in the API route. Node exposes it on
 * globalThis from v19 onward.
 */
function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error(
      "WebCrypto SubtleCrypto is unavailable. In the browser this means the " +
        "page is not in a secure context (https or localhost).",
    );
  }
  return c.subtle;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** SHA-256 over raw bytes, as an 0x-prefixed lowercase hex string. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await subtle().digest("SHA-256", bytes as unknown as BufferSource);
  return toHex(digest);
}

/**
 * SHA-256 over a Blob's bytes.
 *
 * SubtleCrypto has no streaming digest, so the blob is materialised whole.
 * At episode sizes (tens of MB) that is acceptable, but callers on the capture
 * path must run this in a Web Worker: it lands immediately after a recording
 * on a thermally-stressed phone, and the UI thread has to stay alive.
 *
 * If this ever stalls on real hardware the fallback is chunked streaming via
 * hash-wasm, and the change is contained to this function.
 */
export async function sha256Blob(blob: Blob): Promise<string> {
  return sha256Hex(new Uint8Array(await blob.arrayBuffer()));
}

/** Strip the hash field so a manifest cannot cover its own hash. */
function preimage(manifest: Manifest): Manifest {
  if (!(HASH_FIELD in manifest)) return manifest;
  const rest = { ...manifest };
  delete rest[HASH_FIELD];
  return rest;
}

/** Hash of a manifest's canonical form, excluding any existing hash field. */
export async function manifestHash<T extends Manifest>(manifest: T): Promise<string> {
  return sha256Hex(canonicalBytes(preimage(manifest)));
}

/** Attach the manifest's own hash. Idempotent. */
export async function sealManifest<T extends Manifest>(
  manifest: T,
): Promise<T & { [HASH_FIELD]: string }> {
  return { ...manifest, [HASH_FIELD]: await manifestHash(manifest) };
}

/**
 * Recompute and compare. This is what the API route runs on arrival, before
 * anything is pinned or relayed.
 */
export async function verifyManifestHash<T extends Manifest>(manifest: T): Promise<boolean> {
  const claimed = manifest[HASH_FIELD];
  if (typeof claimed !== "string") {
    throw new TypeError(
      `Manifest carries no ${HASH_FIELD}; there is nothing to verify against.`,
    );
  }
  return (await manifestHash(manifest)) === claimed;
}
