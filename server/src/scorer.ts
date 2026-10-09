import { Worker } from "node:worker_threads";
import type { ScoreFn } from "./pipeline";
import type { ScoreOptions, Scores } from "@/lib/validator/score";

/**
 * Scoring decodes video and solves optical flow on the CPU for tens of seconds. Running it on the main
 * thread freezes the HTTP server, so phones polling for a verdict time out. Each episode scores in its own
 * worker thread, one at a time, and the API stays responsive throughout.
 */
export function createWorkerScorer(): ScoreFn {
  let tail: Promise<unknown> = Promise.resolve();

  const run = (video: Uint8Array, imu: Uint8Array, options?: ScoreOptions) =>
    new Promise<Scores>((resolve, reject) => {
      const worker = new Worker(new URL("./scoreWorker.ts", import.meta.url), { execArgv: process.execArgv });
      worker.once("message", (m: { ok: boolean; scores?: Scores; error?: string }) => {
        void worker.terminate();
        m.ok ? resolve(m.scores!) : reject(new Error(m.error));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => code !== 0 && reject(new Error(`Scoring worker exited with code ${code}`)));
      worker.postMessage({ video, imu, options });
    });

  return (video, imu, options) => {
    const next = tail.then(() => run(video, imu, options), () => run(video, imu, options));
    tail = next.catch(() => undefined);
    return next;
  };
}
