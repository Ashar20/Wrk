/**
 * Submits a recorded capture to a running validator, the way the app does. Used for demos and smoke tests.
 *   npx tsx scripts/submit-fixture.ts <fixtureDir> [--imu <otherFixtureDir>] [--bounty bounty_004] [--url http://127.0.0.1:8787]
 * `--imu` pairs this video with another take's motion, which is what a screen replay looks like.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sealManifest, sha256Hex } from "../src/lib/manifest";
import { decodeImuStream } from "../src/lib/capture/imu-codec";

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const dir = args[0];
if (!dir) throw new Error("usage: submit-fixture.ts <fixtureDir> [--imu <dir>] [--bounty id] [--url u] [--contributor addr] [--anchor sig] [--token session]");
const url = flag("--url", "http://127.0.0.1:8787")!;
const bountyId = flag("--bounty", "bounty_004")!;
const contributor = flag("--contributor", "9xQeWvG816bUx9EPfEZEoPqdNaE4gqCNTNqmbFnfZoxM")!;

const rgb = new Uint8Array(readFileSync(join(dir, "rgb.webm")));
const imu = new Uint8Array(readFileSync(join(flag("--imu", dir)!, "imu.bin")));
const stream = decodeImuStream(imu);
const span = (stream.samples.at(-1)!.t - stream.samples[0].t) / 1000;

const id = "ep_" + randomBytes(12).toString("hex");
const manifest = await sealManifest({
  episode_id: id, schema_version: "0.2.0", chain: "solana", cluster: "devnet", asset_id: "asset_demo",
  entity_id: contributor, contributor, bounty_id: bountyId, task: "cup_pick_and_place",
  duration_s: Math.round(span * 1000) / 1000, recorded_at: Math.floor(Date.now() / 1000),
  client: { type: "android_native", version: "0.1.0", ua_class: "other" },
  capture: {
    video: { codec: "video/mp4", width: 720, height: 1280, fps_nominal: 30, fps_observed: 29.7, frame_timing: "recorder_anchored", device_label: "back", fov_deg: null },
    audio: null,
    imu: { rate_hz_observed: stream.samples.length / span, samples: stream.samples.length, imu_frame: "android_sensor_event", rotation_convention: "device_xyz_deg_s", screen_orientation: "portrait" },
  },
  streams: {
    rgb: { sha256: await sha256Hex(rgb), bytes: rgb.length, content_type: "video/mp4" },
    imu: { sha256: await sha256Hex(imu), bytes: imu.length, content_type: "application/octet-stream" },
  },
  sync: { method: "recorder_anchored", measured_skew_ms: null }, outcome: "success", self_report: { task_completed: true, notes: "" },
});

const form = new FormData();
form.set("manifest", JSON.stringify(manifest));
form.set("rgb", new Blob([rgb]), "rgb.mp4");
form.set("imu", new Blob([imu]), "imu.bin");
const anchor = flag("--anchor");
if (anchor) form.set("anchor_signature", anchor);

const token = flag("--token");
const res = await fetch(`${url}/episodes`, { method: "POST", body: form, headers: token ? { authorization: `Bearer ${token}` } : {} });
console.log("upload:", res.status, await res.text());
for (let i = 0; i < 120; i++) {
  const v = await (await fetch(`${url}/episodes/${id}`)).json();
  if (v.status !== "scoring") { console.log(JSON.stringify(v, null, 2)); break; }
  await new Promise((r) => setTimeout(r, 2000));
}
