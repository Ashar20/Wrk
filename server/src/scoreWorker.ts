import { parentPort } from "node:worker_threads";
import { scoreEpisode } from "@/lib/validator/score";

parentPort!.on("message", async ({ video, imu }: { video: Uint8Array; imu: Uint8Array }) => {
  try {
    parentPort!.postMessage({ ok: true, scores: await scoreEpisode(video, imu) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
