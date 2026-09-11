/**
 * Perceptual hashing for near-duplicate detection.
 *
 * product-spec §6.3 names duplicate detection as a supporting check, and it is
 * the one that defends the economics. Cryptographic hashes catch a byte-exact
 * resubmission and nothing else; a contributor who records the same fifteen
 * seconds a hundred times produces a hundred distinct SHA-256 digests and a
 * worthless dataset. Perceptual hashes collide when the *content* matches.
 *
 * dHash is used rather than aHash or pHash: it compares adjacent pixel
 * gradients, so it is invariant to brightness and contrast shifts — exactly
 * what changes between two takes of the same scene under auto-exposure — while
 * staying cheap enough to run on every sampled frame during capture.
 *
 * A 64-bit hash from a 9x8 grayscale reduction: each row contributes 8
 * comparisons between horizontally adjacent pixels.
 */

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;
export const PHASH_BITS = (HASH_WIDTH - 1) * HASH_HEIGHT;

/** Grayscale luminance of an RGBA pixel, Rec. 601. */
function luma(data: Uint8ClampedArray, index: number): number {
  return 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
}

/**
 * Box-downscale to 9x8 grayscale.
 *
 * Averaging over each source block rather than point-sampling matters: point
 * sampling makes the hash sensitive to sub-pixel shifts, so the same scene
 * captured a frame apart would hash differently and duplicates would slip past.
 */
function reduce(image: ImageData): number[] {
  const cells = new Array<number>(HASH_WIDTH * HASH_HEIGHT).fill(0);
  const counts = new Array<number>(HASH_WIDTH * HASH_HEIGHT).fill(0);

  for (let y = 0; y < image.height; y++) {
    const cellY = Math.min(HASH_HEIGHT - 1, Math.floor((y / image.height) * HASH_HEIGHT));
    for (let x = 0; x < image.width; x++) {
      const cellX = Math.min(HASH_WIDTH - 1, Math.floor((x / image.width) * HASH_WIDTH));
      const cell = cellY * HASH_WIDTH + cellX;
      cells[cell] += luma(image.data, (y * image.width + x) * 4);
      counts[cell]++;
    }
  }

  return cells.map((sum, i) => (counts[i] === 0 ? 0 : sum / counts[i]));
}

/**
 * 64-bit difference hash as 16 lowercase hex characters.
 *
 * Held as two 32-bit halves rather than a BigInt: bitwise operators are
 * defined on 32-bit integers, the hash is compared far more often than it is
 * built, and this keeps the module free of any language-target requirement.
 */
export function dHash(image: ImageData): string {
  if (image.width === 0 || image.height === 0) {
    throw new RangeError("Cannot hash an empty image.");
  }

  const cells = reduce(image);
  let hi = 0;
  let lo = 0;
  let index = 0;

  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const bit = cells[y * HASH_WIDTH + x] > cells[y * HASH_WIDTH + x + 1] ? 1 : 0;
      if (index < 32) hi = ((hi << 1) | bit) >>> 0;
      else lo = ((lo << 1) | bit) >>> 0;
      index++;
    }
  }

  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/** Population count of a 32-bit word. */
function popcount(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/** Number of differing bits between two hashes. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new RangeError(`Cannot compare hashes of different widths: ${a.length} vs ${b.length}.`);
  }

  let count = 0;
  for (let offset = 0; offset < a.length; offset += 8) {
    const left = parseInt(a.slice(offset, offset + 8), 16) >>> 0;
    const right = parseInt(b.slice(offset, offset + 8), 16) >>> 0;
    count += popcount((left ^ right) >>> 0);
  }
  return count;
}

/**
 * Similarity in [0,1]. 1 means the frames are perceptually identical.
 */
export function similarity(a: string, b: string): number {
  return 1 - hammingDistance(a, b) / PHASH_BITS;
}

/**
 * A compact signature for a whole episode.
 *
 * Frames are sampled evenly across the episode rather than taken from its
 * start: two different takes of the same task often open on the same static
 * scene, and comparing only the first frames would flag honest work as
 * duplicated.
 */
export function episodeSignature(frameHashes: readonly string[], size = 8): string[] {
  if (frameHashes.length <= size) return [...frameHashes];

  const step = frameHashes.length / size;
  return Array.from({ length: size }, (_, i) => frameHashes[Math.floor(i * step)]);
}
