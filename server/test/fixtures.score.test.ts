import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoreEpisode } from "@/lib/validator/score";

const fx = (dir: string, f: string) => new Uint8Array(readFileSync(join(__dirname, "fixtures", dir, f)));

describe("flow-vs-gyro scoring on recorded episodes", () => {
  it("scores real captures well above a replay built from the same footage", async () => {
    const t0 = Date.now();
    const real = await scoreEpisode(fx("real", "rgb.webm"), fx("real", "imu.bin"));
    console.log("SCORED real ms", Date.now() - t0, "plaus", real.plausibility.percent, "frames", real.framesAnalyzed, "framing", JSON.stringify(real.framing));
    const real2 = await scoreEpisode(fx("real2", "rgb.webm"), fx("real2", "imu.bin"));
    // A replay: genuine video paired with motion from a different take.
    const replay = await scoreEpisode(fx("real", "rgb.webm"), fx("real2", "imu.bin"));
    console.log("SCORES", real.plausibility.percent, real2.plausibility.percent, replay.plausibility.percent, replay.plausibility.verdict);
    expect(real.plausibility.percent).toBeGreaterThanOrEqual(60);
    expect(real2.plausibility.percent).toBeGreaterThanOrEqual(60);
    expect(replay.plausibility.percent ?? 0).toBeLessThan(40);
  }, 900_000);
});
