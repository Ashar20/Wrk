import { describe, expect, it } from "vitest";
import { findDuplicates, signatureSimilarity, type EpisodeFingerprint } from "./duplicate";
import { dHash, episodeSignature, hammingDistance, PHASH_BITS, similarity } from "./phash";

const W = 64;
const H = 48;

/** A textured scene; `seed` changes the content, `shift` moves it. */
function scene({ seed = 1, shift = 0, brightness = 0, noise = 0 } = {}): ImageData {
  const data = new Uint8ClampedArray(W * H * 4);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = ((x + shift) / W) * Math.PI * 2;
      const v = (y / H) * Math.PI * 2;
      const value =
        128 +
        70 * Math.sin(3 * u + seed) * Math.cos(2 * v) +
        40 * Math.sin(5 * u + 2 * v + seed) +
        (noise === 0 ? 0 : ((x * 7 + y * 13 + seed) % 17) * noise);

      const level = Math.max(0, Math.min(255, value + brightness));
      const i = (y * W + x) * 4;
      data[i] = level;
      data[i + 1] = level;
      data[i + 2] = level;
      data[i + 3] = 255;
    }
  }

  return { data, width: W, height: H, colorSpace: "srgb" } as ImageData;
}

describe("dHash", () => {
  it("produces a 64-bit hash as 16 hex characters", () => {
    expect(dHash(scene())).toMatch(/^[0-9a-f]{16}$/);
    expect(PHASH_BITS).toBe(64);
  });

  it("is deterministic", () => {
    expect(dHash(scene({ seed: 4 }))).toBe(dHash(scene({ seed: 4 })));
  });

  it("differs for different scenes", () => {
    expect(dHash(scene({ seed: 1 }))).not.toBe(dHash(scene({ seed: 9 })));
  });

  it("is invariant to a uniform brightness shift", () => {
    // Auto-exposure changes brightness between takes of the same scene. A hash
    // that moved with it would let re-recordings pass as fresh content.
    expect(similarity(dHash(scene()), dHash(scene({ brightness: 45 })))).toBeGreaterThan(0.9);
  });

  it("survives mild noise", () => {
    expect(similarity(dHash(scene()), dHash(scene({ noise: 2 })))).toBeGreaterThan(0.85);
  });

  it("separates different scenes well below the duplicate threshold", () => {
    expect(similarity(dHash(scene({ seed: 1 })), dHash(scene({ seed: 40 })))).toBeLessThan(0.9);
  });

  it("rejects an empty image rather than hashing nothing", () => {
    const empty = { data: new Uint8ClampedArray(0), width: 0, height: 0 } as ImageData;
    expect(() => dHash(empty)).toThrow(/empty image/i);
  });
});

describe("hammingDistance", () => {
  it("is zero for identical hashes", () => {
    expect(hammingDistance("ffffffffffffffff", "ffffffffffffffff")).toBe(0);
  });

  it("counts every differing bit", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingDistance("0000000000000000", "0000000000000003")).toBe(2);
  });

  it("refuses to compare hashes of different widths", () => {
    expect(() => hammingDistance("ff", "ffffffffffffffff")).toThrow(/different widths/i);
  });
});

describe("episodeSignature", () => {
  it("samples evenly across the episode, not just the opening", () => {
    // Two takes of one task often share an opening static frame; comparing
    // only the start would flag honest work as duplicated.
    const hashes = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(16, "0"));
    const signature = episodeSignature(hashes, 8);

    expect(signature).toHaveLength(8);
    expect(signature[0]).toBe(hashes[0]);
    expect(signature[7]).toBe(hashes[35]);
  });

  it("returns everything when there is less than a full signature", () => {
    const hashes = ["a".repeat(16), "b".repeat(16)];
    expect(episodeSignature(hashes, 8)).toEqual(hashes);
  });
});

describe("findDuplicates", () => {
  function fingerprint(id: string, entity: string, seeds: number[]): EpisodeFingerprint {
    return {
      episode_id: id,
      entity_id: entity,
      signature: seeds.map((seed) => dHash(scene({ seed }))),
    };
  }

  const original = fingerprint("ep_1", "0xA", [1, 2, 3, 4]);

  it("flags a re-recording of the same content", () => {
    // The farming case: the same fifteen seconds recorded again. Every byte
    // differs, so a cryptographic hash sees nothing.
    const rerecord: EpisodeFingerprint = {
      episode_id: "ep_2",
      entity_id: "0xA",
      signature: [1, 2, 3, 4].map((seed) => dHash(scene({ seed, brightness: 12 }))),
    };

    const [match] = findDuplicates(rerecord, [original]);
    expect(match).toBeDefined();
    expect(match.similarity).toBeGreaterThan(0.9);
    expect(match.sameEntity).toBe(true);
  });

  it("does not flag genuinely different work", () => {
    const different = fingerprint("ep_3", "0xA", [30, 41, 52, 63]);
    expect(findDuplicates(different, [original])).toEqual([]);
  });

  it("never compares an episode against itself", () => {
    expect(findDuplicates(original, [original])).toEqual([]);
  });

  it("can restrict comparison to the same contributor", () => {
    const other = fingerprint("ep_9", "0xB", [1, 2, 3, 4]);

    expect(findDuplicates(other, [original], { sameEntityOnly: true })).toEqual([]);
    expect(findDuplicates(other, [original]).length).toBeGreaterThan(0);
  });

  it("reports the closest match first", () => {
    const near = fingerprint("ep_near", "0xA", [1, 2, 3, 4]);
    const far = fingerprint("ep_far", "0xA", [1, 2, 3, 60]);
    const matches = findDuplicates(near, [far, original], { threshold: 0.5 });

    expect(matches[0].similarity).toBeGreaterThanOrEqual(matches[1].similarity);
  });

  it("scores an empty signature as no match rather than a perfect one", () => {
    expect(signatureSimilarity([], ["a".repeat(16)])).toBe(0);
    expect(signatureSimilarity(["a".repeat(16)], [])).toBe(0);
  });
});
