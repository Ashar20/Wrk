// Emits golden vectors from the reference TypeScript implementation so the
// Kotlin ports can be proven byte-identical. Run via scripts/gen-golden.sh
import { writeFileSync } from "node:fs";
const REF = process.env.REF;
const { canonicalize } = await import(`${REF}/manifest/canonicalize.ts`);
const { manifestHash, sha256Hex } = await import(`${REF}/manifest/hash.ts`);
const { encodeImuStream } = await import(`${REF}/capture/imu-codec.ts`);

const out = "app/src/test/resources/golden";
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const canonInputs = [
  { b: 2, a: 1, c: { z: [3, 2, 1], y: null } },
  { n: [17.2, 0.1, 1, -0, 98.4, 123456789.125, 0.5, 30, 1757030400, -3.25] },
  { s: ["a\"b", "line\nbreak", "tab\t", "\u0001", "é", "😀", "back\\slash", "\u007f"] },
  {}, [], { e: {}, f: [] }, { "ä": 1, "a": 2, "Z": 3, "10": 4, "9": 5 },
  { t: true, f: false, nul: null },
];
writeFileSync(`${out}/canonical.json`, JSON.stringify(
  canonInputs.map((input) => ({ input, expected: canonicalize(input) })), null, 2));

const imu = {
  startedAtEpochMs: 1757030400123.5,
  samples: [
    { t: 0, ax: 0.1, ay: -9.81, az: 0.02, rx: 0.5, ry: -0.25, rz: 0.1 },
    { t: 10.2, ax: 0.12, ay: -9.8, az: 0.03, rx: 0.51, ry: -0.2, rz: 0.11 },
    { t: 20.4, ax: -1.5, ay: 2.25, az: 3.125, rx: -4, ry: 5.5, rz: -6.75 },
  ],
};
const imuBytes = encodeImuStream(imu);
writeFileSync(`${out}/imu.json`, JSON.stringify({
  stream: imu, hex: hex(imuBytes), sha256: await sha256Hex(imuBytes),
}, null, 2));

const manifest = {
  episode_id: "ep_0f3a0f3a0f3a0f3a0f3a0f3a", schema_version: "0.2.0", chain: "solana", cluster: "devnet",
  asset_id: "asset_9281", entity_id: "9xQeWvG816bUx9EPfEZEoPqdNaE4gqCNTNqmbFnfZoxM", contributor: "9xQeWvG816bUx9EPfEZEoPqdNaE4gqCNTNqmbFnfZoxM",
  bounty_id: "bounty_004", task: "cup_pick_and_place", duration_s: 17.2, recorded_at: 1757030400,
  client: { type: "android_native", version: "0.1.0", ua_class: "other" },
  capture: {
    video: { codec: "video/mp4", width: 1280, height: 720, fps_nominal: 30, fps_observed: 29.7, frame_timing: "recorder_anchored", device_label: "back", fov_deg: null },
    audio: null,
    imu: { rate_hz_observed: 98.4, samples: 1692, imu_frame: "android_sensor_event", rotation_convention: "android_gyro_rad_s_xyz", screen_orientation: "portrait" },
  },
  streams: {
    rgb: { sha256: "0x" + "ab".repeat(32), bytes: 1234567, content_type: "video/mp4" },
    imu: { sha256: "0x" + "cd".repeat(32), bytes: 47396, content_type: "application/octet-stream" },
  },
  sync: { method: "recorder_anchored", measured_skew_ms: 20.5 },
  outcome: "success", self_report: { task_completed: true, notes: "café ☕" },
};
writeFileSync(`${out}/manifest.json`, JSON.stringify({ manifest, manifest_hash: await manifestHash(manifest) }, null, 2));
console.log("ok");
