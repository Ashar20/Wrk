import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/manifest";
import {
  decodeImuStream,
  encodeImuStream,
  imuStreamByteLength,
  type ImuStream,
} from "./imu-codec";

function stream(count: number): ImuStream {
  return {
    startedAtEpochMs: 1786550400123,
    samples: Array.from({ length: count }, (_, i) => ({
      t: i * (1000 / 60),
      ax: 0.25 * i,
      ay: -0.5,
      az: 9.8125,
      rx: 1.5,
      ry: -2.25,
      rz: 0.125,
    })),
  };
}

describe("IMU codec", () => {
  it("round-trips values that are exactly representable as f32", () => {
    const original = stream(3);
    const decoded = decodeImuStream(encodeImuStream(original));

    expect(decoded.startedAtEpochMs).toBe(original.startedAtEpochMs);
    expect(decoded.samples).toHaveLength(3);
    // Every value in the fixture is a dyadic rational, so f32 is exact.
    expect(decoded.samples[0]).toEqual(original.samples[0]);
    expect(decoded.samples[2].ax).toBe(0.5);
  });

  it("stores samples at f32, rounding values that need more precision", () => {
    // Sensor noise floors are orders of magnitude above f32 resolution, so
    // this is a deliberate size trade rather than an accident. It is tested
    // so nobody later assumes IMU values survive bit-exact.
    const s = stream(1);
    s.samples[0].az = 9.81;
    const decoded = decodeImuStream(encodeImuStream(s));
    expect(decoded.samples[0].az).not.toBe(9.81);
    expect(decoded.samples[0].az).toBeCloseTo(9.81, 5);
  });

  it("preserves the wall-clock anchor at full f64 precision", () => {
    // Epoch milliseconds do not fit in f32; the header stores them as f64.
    const decoded = decodeImuStream(encodeImuStream(stream(1)));
    expect(decoded.startedAtEpochMs).toBe(1786550400123);
  });

  it("produces byte-identical output for identical input", async () => {
    const a = encodeImuStream(stream(50));
    const b = encodeImuStream(stream(50));
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
  });

  it("produces a different hash when any sample changes", async () => {
    const base = stream(50);
    const nudged = structuredClone(base);
    nudged.samples[25].rx = 1.75;

    expect(await sha256Hex(encodeImuStream(base))).not.toBe(
      await sha256Hex(encodeImuStream(nudged)),
    );
  });

  it("occupies the byte length it predicts", () => {
    expect(encodeImuStream(stream(60)).byteLength).toBe(imuStreamByteLength(60));
    expect(imuStreamByteLength(0)).toBe(20);
  });

  it("handles an empty stream", () => {
    const decoded = decodeImuStream(encodeImuStream({ startedAtEpochMs: 0, samples: [] }));
    expect(decoded.samples).toEqual([]);
  });

  it("rejects non-finite sample values rather than encoding a silent NaN", () => {
    const bad = stream(2);
    bad.samples[1].rx = NaN;
    expect(() => encodeImuStream(bad)).toThrow(/non-finite rx/i);
  });

  it("rejects bytes that are not an IMU stream", () => {
    expect(() => decodeImuStream(new Uint8Array(20))).toThrow(/bad magic/i);
  });

  it("rejects a truncated stream rather than returning partial samples", () => {
    const full = encodeImuStream(stream(10));
    expect(() => decodeImuStream(full.subarray(0, full.byteLength - 4))).toThrow(
      /truncated or corrupt/i,
    );
  });

  it("rejects a stream shorter than its header", () => {
    expect(() => decodeImuStream(new Uint8Array(4))).toThrow(/shorter than its header/i);
  });

  it("decodes correctly when the stream sits at a non-zero buffer offset", () => {
    // Blob reads and worker transfers routinely produce views into a larger
    // buffer; DataView must be constructed against the view, not the buffer.
    const encoded = encodeImuStream(stream(4));
    const padded = new Uint8Array(encoded.byteLength + 8);
    padded.set(encoded, 8);

    const decoded = decodeImuStream(padded.subarray(8));
    expect(decoded.samples).toHaveLength(4);
    expect(decoded.startedAtEpochMs).toBe(1786550400123);
  });
});
