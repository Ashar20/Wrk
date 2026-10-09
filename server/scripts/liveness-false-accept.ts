/**
 * How often would a take recorded BEFORE the challenge existed pass the live check?
 * Measures the real recordings in test/fixtures against thousands of random challenges. Those takes contain genuine
 * head movement, just not the movement that was asked for, which is exactly what a replay looks like.
 *   npx tsx scripts/liveness-false-accept.ts
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tf from "@tensorflow/tfjs";
import { checkLiveness } from "@/lib/analysis/liveness";
import { decodeImuStream } from "@/lib/capture/imu-codec";
import { extractFrames, flowSeries } from "@/lib/validator/score";
import { LivenessChallenges } from "../src/liveness";

await tf.setBackend("cpu"); await tf.ready();
const dir = await mkdtemp(join(tmpdir(), "wrk-live-"));
const ROUNDS = 3000;
const challenges = new LivenessChallenges();

for (const name of ["real", "real2"]) {
  const video = join(dir, `${name}.webm`);
  await writeFile(video, await readFile(`test/fixtures/${name}/rgb.webm`));
  const imu = decodeImuStream(new Uint8Array(await readFile(`test/fixtures/${name}/imu.bin`))).samples;
  const flow = await flowSeries(await extractFrames(video));
  const rms = (k: "rx" | "ry") => Math.sqrt(imu.reduce((a, x) => a + x[k] * x[k], 0) / imu.length);
  console.log(`${name}: overall rotation RMS: yaw ${rms("ry").toFixed(1)} deg/s, pitch ${rms("rx").toFixed(1)} deg/s (a prompted head turn needs ~6+ deg/s)`);
  let pass = 0, two = 0, matchedTotal = 0, loosePass = 0, looseMatched = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const { prompts } = challenges.issue();
    const shown = prompts.filter((p) => p.at_ms + 3000 <= (imu.at(-1)?.t ?? 0)); // only prompts that fit in the take
    const r = checkLiveness(flow, imu, shown);
    matchedTotal += r.matched; if (r.passed) pass++; if (shown.length >= 2) two++;
    // Same check with the "enough movement" rule removed, to see whether axis and timing alone would let a replay through.
    const loose = checkLiveness(flow, imu, shown, { minRmsDegPerSec: 0 });
    looseMatched += loose.matched; if (loose.passed) loosePass++;
  }
  console.log(`${name}: ${imu.length} motion samples, ${flow.length} flow steps, ${(imu.at(-1)?.t ?? 0) / 1000}s`);
  console.log(`  passed ${pass} of ${ROUNDS} random challenges (${((100 * pass) / ROUNDS).toFixed(2)}%); avg prompts matched ${(matchedTotal / ROUNDS).toFixed(2)}; takes long enough for 2+ prompts: ${two}`);
  console.log(`  with the movement-size rule off: passed ${loosePass} of ${ROUNDS} (${((100 * loosePass) / ROUNDS).toFixed(2)}%); avg prompts matched ${(looseMatched / ROUNDS).toFixed(2)} of ${(ROUNDS ? 4 : 0)} possible`);
}
