import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize";
import { manifestHash, sealManifest, sha256Hex, verifyManifestHash } from "./hash";

describe("sha256Hex", () => {
  it("matches the published SHA-256 vector for 'abc'", async () => {
    const bytes = new TextEncoder().encode("abc");
    expect(await sha256Hex(bytes)).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the published SHA-256 vector for the empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("manifestHash", () => {
  const base = {
    episode_id: "ep_0f3a",
    schema_version: "0.1.0",
    duration_s: 17.2,
  };

  it("hashes the canonical form of the manifest", async () => {
    const expected = await sha256Hex(new TextEncoder().encode(canonicalize(base)));
    expect(await manifestHash(base)).toBe(expected);
  });

  it("is insensitive to key insertion order", async () => {
    const reordered = {
      duration_s: 17.2,
      schema_version: "0.1.0",
      episode_id: "ep_0f3a",
    };
    expect(await manifestHash(reordered)).toBe(await manifestHash(base));
  });

  it("excludes an existing manifest_hash field from its own preimage", async () => {
    const withHash = { ...base, manifest_hash: "0xdeadbeef" };
    expect(await manifestHash(withHash)).toBe(await manifestHash(base));
  });

  it("changes when any covered field changes", async () => {
    const mutated = { ...base, duration_s: 17.3 };
    expect(await manifestHash(mutated)).not.toBe(await manifestHash(base));
  });
});

describe("sealManifest / verifyManifestHash", () => {
  const manifest = { episode_id: "ep_0f3a", schema_version: "0.1.0" };

  it("seals a manifest with a hash that verifies", async () => {
    const sealed = await sealManifest(manifest);
    expect(sealed.manifest_hash).toBe(await manifestHash(manifest));
    await expect(verifyManifestHash(sealed)).resolves.toBe(true);
  });

  it("is idempotent — re-sealing does not change the hash", async () => {
    const once = await sealManifest(manifest);
    const twice = await sealManifest(once);
    expect(twice.manifest_hash).toBe(once.manifest_hash);
  });

  it("detects a mutated field after sealing", async () => {
    const sealed = await sealManifest({ ...manifest, duration_s: 17.2 });
    const tampered = { ...sealed, duration_s: 17.3 };
    await expect(verifyManifestHash(tampered)).resolves.toBe(false);
  });

  it("detects a swapped manifest_hash", async () => {
    const sealed = await sealManifest(manifest);
    const tampered = { ...sealed, manifest_hash: "0x" + "00".repeat(32) };
    await expect(verifyManifestHash(tampered)).resolves.toBe(false);
  });

  it("rejects a manifest that carries no hash at all", async () => {
    await expect(verifyManifestHash(manifest)).rejects.toThrow(/manifest_hash/i);
  });
});
