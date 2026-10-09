import { randomBytes, randomInt } from "node:crypto";
import type { Axis, Prompt } from "@/lib/analysis/liveness";

export const PROMPT_COUNT = 4;
export const MIN_PROMPTS = 2;
/** Prompts are always at least this far apart, so one movement can't be mistaken for the next. */
export const MIN_GAP_MS = 3600;

const TTL_MS = 15 * 60_000;
const MAX_OUTSTANDING = 5_000;

export class LivenessError extends Error {}

/**
 * Hands out a random movement sequence, with random timing, per take and takes it back exactly once. The sequence is
 * unknown until the app asks for it, which is what makes a recording made earlier useless.
 */
export class LivenessChallenges {
  private issued = new Map<string, { prompts: Prompt[]; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue() {
    const t = this.now();
    for (const [n, c] of this.issued) if (c.expiresAt < t) this.issued.delete(n);
    while (this.issued.size >= MAX_OUTSTANDING) this.issued.delete(this.issued.keys().next().value!);

    // Random moments and random axes: neither can be known from an earlier recording, and a clip shifted in time lands its
    // movement in the wrong place. First prompt 1.8 to 2.6 s in, then 3.6 to 4.6 s apart.
    let at = 1800 + randomInt(800);
    const prompts: Prompt[] = [];
    for (let i = 0; i < PROMPT_COUNT; i++) {
      prompts.push({ at_ms: at, axis: (randomInt(2) === 0 ? "yaw" : "pitch") as Axis });
      at += MIN_GAP_MS + randomInt(1000);
    }
    const nonce = randomBytes(16).toString("hex");
    this.issued.set(nonce, { prompts, expiresAt: t + TTL_MS });
    return { nonce, prompts };
  }

  /**
   * The app reports which prompts it actually showed (as many as fit in the take). They must be the first N of what was
   * issued, at least [MIN_PROMPTS] of them, and the nonce is spent whatever the outcome.
   */
  consume(nonce: unknown, shown: unknown): Prompt[] {
    const c = typeof nonce === "string" ? this.issued.get(nonce) : undefined;
    if (typeof nonce === "string") this.issued.delete(nonce);
    if (!c || c.expiresAt < this.now()) throw new LivenessError("The live check expired or was already used. Record again.");
    if (!Array.isArray(shown) || shown.length < MIN_PROMPTS || shown.length > c.prompts.length) {
      throw new LivenessError("The live check wasn't completed. Follow the on-screen prompts and record again.");
    }
    const ok = shown.every((p, i) => p && typeof p === "object" && (p as Prompt).axis === c.prompts[i].axis && (p as Prompt).at_ms === c.prompts[i].at_ms);
    if (!ok) throw new LivenessError("The live check didn't match what was asked. Record again.");
    return c.prompts.slice(0, shown.length);
  }
}
