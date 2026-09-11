import { describe, expect, it } from "vitest";
import { sealManifest, sha256Hex, type Manifest } from "@/lib/manifest";
import type { EpisodeFingerprint } from "./duplicate";
import { score, validateEpisode, verifyManifestIntegrity, type ValidationChecks } from "./validate";

const RGB_BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const IMU_BYTES = new Uint8Array([9, 8, 7]);

async function manifest(overrides: Record<string, unknown> = {}): Promise<Manifest> {
  const base: Manifest = {
    episode_id: "ep_test",
    schema_version: "0.2.0",
    duration_s: 15,
    capture: {
      video: { fps_nominal: 30, fps_observed: 28.4 },
      imu: { rate_hz_observed: 60 },
    },
    streams: {
      rgb: { sha256: await sha256Hex(RGB_BYTES), bytes: RGB_BYTES.length },
      imu: { sha256: await sha256Hex(IMU_BYTES), bytes: IMU_BYTES.length },
    },
    // Kept deliberately: a client CAN put this in a sealed manifest, and one
    // test below proves the validator pays no attention to it.
    quality: { plausibility_percent: 100, framing_percent: 100 },
    ...overrides,
  };
  return sealManifest(base);
}

async function streams() {
  return [
    { kind: "rgb", sha256: await sha256Hex(RGB_BYTES), bytes: RGB_BYTES },
    { kind: "imu", sha256: await sha256Hex(IMU_BYTES), bytes: IMU_BYTES },
  ];
}

const base = {
  requiredModalities: ["rgb", "imu"] as const,
  durationRangeS: [8, 30] as const,
  scores: { plausibilityPercent: 83, framingPercent: 97 },
};

describe("verifyManifestIntegrity", () => {
  it("accepts a manifest that matches its own hash", async () => {
    await expect(verifyManifestIntegrity(await manifest())).resolves.toBe(true);
  });

  it("rejects a manifest whose contents were altered after sealing", async () => {
    const tampered = { ...(await manifest()), duration_s: 29 };
    await expect(verifyManifestIntegrity(tampered)).resolves.toBe(false);
  });

  it("rejects a manifest with no hash at all", async () => {
    await expect(verifyManifestIntegrity({ episode_id: "x" })).resolves.toBe(false);
  });
});

describe("validateEpisode", () => {
  it("passes a well-formed episode with its bytes", async () => {
    const result = await validateEpisode({
      manifest: await manifest(),
      streams: await streams(),
      ...base,
    });

    expect(result.failures).toEqual([]);
    expect(result.checks.manifest_intact).toBe(true);
    expect(result.checks.streams_intact).toBe(true);
    expect(result.checks.completeness).toBe(1);
    expect(result.trust_level).toBe("heuristic");
    expect(result.plausibility_score).toBeGreaterThan(0.8);
  });

  it("scores zero when the manifest does not match its own hash", async () => {
    // Integrity is a gate, not a term: good-looking footage under a broken
    // commitment is worth nothing.
    const tampered = { ...(await manifest()), duration_s: 12 };
    const result = await validateEpisode({ manifest: tampered, streams: await streams(), ...base });

    expect(result.plausibility_score).toBe(0);
    expect(result.failures.join(" ")).toMatch(/hash does not match/i);
  });

  it("catches bytes that do not match the digest the manifest declares", async () => {
    const swapped = await streams();
    swapped[0] = { ...swapped[0], bytes: new Uint8Array([9, 9, 9]) };

    const result = await validateEpisode({ manifest: await manifest(), streams: swapped, ...base });
    expect(result.checks.streams_intact).toBe(false);
    expect(result.failures.join(" ")).toMatch(/do not match the digest/i);
  });

  it("says integrity is unverified when no bytes were supplied", async () => {
    // Distinct from corruption, and the difference matters to a buyer.
    const result = await validateEpisode({ manifest: await manifest(), ...base });

    expect(result.checks.streams_intact).toBe(false);
    expect(result.failures.join(" ")).toMatch(/no stream bytes were supplied/i);
  });

  it("reports missing required modalities", async () => {
    const m = await manifest({
      streams: { rgb: { sha256: await sha256Hex(RGB_BYTES), bytes: 5 } },
    });
    const result = await validateEpisode({ manifest: m, streams: await streams(), ...base });

    expect(result.checks.completeness).toBe(0.5);
    expect(result.failures.join(" ")).toMatch(/missing required modalities: imu/i);
  });

  it("rejects a duration outside the accepted range", async () => {
    const result = await validateEpisode({
      manifest: await manifest({ duration_s: 45 }),
      streams: await streams(),
      ...base,
    });

    expect(result.checks.duration_ok).toBe(false);
    expect(result.plausibility_score).toBe(0);
  });

  it("accepts an unknown observed frame rate, which Safari cannot report", async () => {
    const m = await manifest({
      capture: { video: { fps_nominal: 30, fps_observed: null }, imu: { rate_hz_observed: 60 } },
    });
    const result = await validateEpisode({ manifest: m, streams: await streams(), ...base });

    expect(result.checks.frame_rate_ok).toBe(true);
  });

  it("rejects an observed frame rate that contradicts the nominal one", async () => {
    // A hand-written manifest claiming more frames than the camera can produce.
    const m = await manifest({
      capture: { video: { fps_nominal: 30, fps_observed: 240 }, imu: { rate_hz_observed: 60 } },
    });
    const result = await validateEpisode({ manifest: m, streams: await streams(), ...base });

    expect(result.checks.frame_rate_ok).toBe(false);
  });

  it("rejects an IMU too sparse to support the motion checks", async () => {
    const m = await manifest({
      capture: { video: { fps_nominal: 30, fps_observed: 28 }, imu: { rate_hz_observed: 3 } },
    });
    const result = await validateEpisode({ manifest: m, streams: await streams(), ...base });

    expect(result.checks.imu_rate_ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/too sparse/i);
  });

  it("scores a near-duplicate at zero and names what it matched", async () => {
    const signature = ["1111222233334444", "5555666677778888"];
    const fingerprint: EpisodeFingerprint = { episode_id: "ep_new", entity_id: "0xA", signature };
    const prior: EpisodeFingerprint[] = [
      { episode_id: "ep_old", entity_id: "0xA", signature },
    ];

    const result = await validateEpisode({
      manifest: await manifest(),
      streams: await streams(),
      fingerprint,
      priorFingerprints: prior,
      ...base,
    });

    expect(result.checks.duplicate_of).toBe("ep_old");
    expect(result.plausibility_score).toBe(0);
    expect(result.failures.join(" ")).toMatch(/matches episode ep_old/i);
  });

  it("carries the server's measured scores through as checks", async () => {
    const result = await validateEpisode({
      manifest: await manifest(),
      streams: await streams(),
      ...base,
    });

    expect(result.checks.flow_gyro_corr).toBeCloseTo(0.83, 6);
    expect(result.checks.framing).toBeCloseTo(0.97, 6);
  });

  it("ignores scores a client wrote into its own manifest", async () => {
    // The fixture's manifest declares 100% on both, sealed and hashing
    // correctly — a contributor computes their own commitment, so nothing
    // stops them. Passing no measured scores must leave both unknown rather
    // than believing the manifest.
    const result = await validateEpisode({
      manifest: await manifest(),
      streams: await streams(),
      requiredModalities: base.requiredModalities,
      durationRangeS: base.durationRangeS,
    });

    expect(result.checks.manifest_intact).toBe(true);
    expect(result.checks.flow_gyro_corr).toBeNull();
    expect(result.checks.framing).toBeNull();
  });

  it("does not fail integrity on an episode carrying measured scores", async () => {
    // The regression this file exists to prevent. Scores used to be injected
    // into the manifest before validation, which changed the bytes the hash
    // covered; every genuine episode came back both intact and mismatched, and
    // was gated to zero.
    const result = await validateEpisode({
      manifest: await manifest(),
      streams: await streams(),
      ...base,
    });

    expect(result.checks.manifest_intact).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.plausibility_score).toBeGreaterThan(0);
  });
});

describe("score", () => {
  function checks(overrides: Partial<ValidationChecks> = {}): ValidationChecks {
    return {
      manifest_intact: true,
      streams_intact: true,
      completeness: 1,
      duration_ok: true,
      frame_rate_ok: true,
      imu_rate_ok: true,
      flow_gyro_corr: 0.9,
      framing: 0.95,
      duplicate_of: null,
      duplicate_similarity: null,
      ...overrides,
    };
  }

  it("caps an episode with no motion evidence below one that has it", async () => {
    // A seated capture can be perfectly honest and still prove less. It should
    // never outscore an episode that carries cross-modal agreement.
    const withMotion = score(checks());
    const withoutMotion = score(checks({ flow_gyro_corr: null }));

    expect(withoutMotion).toBeLessThan(withMotion);
    expect(withoutMotion).toBeLessThanOrEqual(0.6);
  });

  it("weights cross-modal agreement above the structural checks", async () => {
    const strong = score(checks({ flow_gyro_corr: 0.95 }));
    const weak = score(checks({ flow_gyro_corr: 0.2 }));
    expect(strong - weak).toBeGreaterThan(0.2);
  });

  it("returns zero on any gate failure", () => {
    expect(score(checks({ manifest_intact: false }))).toBe(0);
    expect(score(checks({ duplicate_of: "ep_x" }))).toBe(0);
    expect(score(checks({ duration_ok: false }))).toBe(0);
  });

  it("never exceeds one", () => {
    expect(score(checks({ flow_gyro_corr: 1, framing: 1 }))).toBeLessThanOrEqual(1);
  });
});
