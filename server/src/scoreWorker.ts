import { parentPort } from "node:worker_threads";
import { scoreEpisode, type ScoreOptions } from "@/lib/validator/score";

parentPort!.on("message", async ({ video, imu, options }: { video: Uint8Array; imu: Uint8Array; options?: ScoreOptions }) => {
  try {
    parentPort!.postMessage({ ok: true, scores: await scoreEpisode(video, imu, options) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
