/**
 * IMU stream binary format.
 *
 * IMU samples are serialized to bytes and hashed like any other stream rather
 * than embedded in the manifest as JSON numbers. Writing raw IEEE-754 bits
 * removes float-to-string formatting from the trust path entirely: two runtimes
 * cannot disagree about the bytes the way they can disagree about whether a
 * value renders as 0.1 or 0.09999999999999999.
 *
 * See docs/superpowers/specs/2026-08-23-contributor-pwa-design.md §4.2.
 *
 * Layout (little-endian throughout):
 *
 *   offset  size  field
 *   0       6     magic "WMIMU1"
 *   6       1     format version
 *   7       1     reserved (0)
 *   8       8     f64 started_at_epoch_ms
 *   16      4     u32 sample_count
 *   20      28n   samples: f32 t_ms, ax, ay, az, rx, ry, rz
 */

export const IMU_MAGIC = "WMIMU1";
export const IMU_FORMAT_VERSION = 1;

const HEADER_BYTES = 20;
const SAMPLE_BYTES = 28;
const FIELDS_PER_SAMPLE = 7;

/**
 * One motion reading. `t` is milliseconds since capture start on the client's
 * monotonic clock — not wall time, which can step mid-episode.
 */
export interface ImuSample {
  t: number;
  /** Acceleration, m/s². Source recorded separately; iOS may only offer gravity-inclusive. */
  ax: number;
  ay: number;
  az: number;
  /** Rotation rate, deg/s, in DeviceMotionEvent convention (alpha=z, beta=x, gamma=y). */
  rx: number;
  ry: number;
  rz: number;
}

export interface ImuStream {
  startedAtEpochMs: number;
  samples: ImuSample[];
}

function assertFinite(value: number, label: string, index: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `IMU sample ${index} has non-finite ${label} (${String(value)}). ` +
        "The recorder must substitute a value for absent sensor components " +
        "rather than passing null through.",
    );
  }
}

export function encodeImuStream(stream: ImuStream): Uint8Array {
  const { startedAtEpochMs, samples } = stream;

  if (!Number.isFinite(startedAtEpochMs)) {
    throw new RangeError("startedAtEpochMs must be finite.");
  }

  const buffer = new ArrayBuffer(HEADER_BYTES + samples.length * SAMPLE_BYTES);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < IMU_MAGIC.length; i++) bytes[i] = IMU_MAGIC.charCodeAt(i);
  view.setUint8(6, IMU_FORMAT_VERSION);
  view.setUint8(7, 0);
  view.setFloat64(8, startedAtEpochMs, true);
  view.setUint32(16, samples.length, true);

  samples.forEach((s, i) => {
    const fields: [number, string][] = [
      [s.t, "t"],
      [s.ax, "ax"],
      [s.ay, "ay"],
      [s.az, "az"],
      [s.rx, "rx"],
      [s.ry, "ry"],
      [s.rz, "rz"],
    ];
    const base = HEADER_BYTES + i * SAMPLE_BYTES;
    fields.forEach(([value, label], f) => {
      assertFinite(value, label, i);
      view.setFloat32(base + f * 4, value, true);
    });
  });

  return bytes;
}

export function decodeImuStream(bytes: Uint8Array): ImuStream {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new RangeError("IMU stream is shorter than its header.");
  }

  const magic = String.fromCharCode(...bytes.subarray(0, IMU_MAGIC.length));
  if (magic !== IMU_MAGIC) {
    throw new RangeError(`Not an IMU stream: bad magic ${JSON.stringify(magic)}.`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(6);
  if (version !== IMU_FORMAT_VERSION) {
    throw new RangeError(`Unsupported IMU format version ${version}.`);
  }

  const startedAtEpochMs = view.getFloat64(8, true);
  const count = view.getUint32(16, true);

  const expected = HEADER_BYTES + count * SAMPLE_BYTES;
  if (bytes.byteLength !== expected) {
    throw new RangeError(
      `IMU stream declares ${count} samples (${expected} bytes) but is ` +
        `${bytes.byteLength} bytes. Truncated or corrupt.`,
    );
  }

  const samples: ImuSample[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = HEADER_BYTES + i * SAMPLE_BYTES;
    const f = (n: number) => view.getFloat32(base + n * 4, true);
    samples[i] = { t: f(0), ax: f(1), ay: f(2), az: f(3), rx: f(4), ry: f(5), rz: f(6) };
  }

  return { startedAtEpochMs, samples };
}

/** Byte length an encoded stream will occupy, without building it. */
export function imuStreamByteLength(sampleCount: number): number {
  return HEADER_BYTES + sampleCount * SAMPLE_BYTES;
}

export { FIELDS_PER_SAMPLE, HEADER_BYTES, SAMPLE_BYTES };
