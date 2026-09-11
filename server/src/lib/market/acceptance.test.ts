import { describe, expect, it } from "vitest";
import { evaluateEpisode, lacksMotionEvidence, meetsTrustLevel } from "./acceptance";
import { budgetBreakdown, type Bounty, type EpisodeSubmission } from "./types";

const NOW = 1_787_000_000;

function bounty(overrides: Partial<Bounty> = {}): Bounty {
  return {
    bounty_id: "bounty_typing_001",
    title: "Typing at a keyboard",
    task_spec: "Sit at a desk and type on a keyboard. Head-mounted view, hands in frame.",
    task: "keyboard_typing",
    required_modalities: ["rgb", "imu"],
    min_episodes: 100,
    duration_range_s: [8, 30],
    min_plausibility: 0.7,
    motion_policy: "allow_static",
    min_framing: 0.7,
    min_trust_level: "heuristic",
    budget_usdc: 100,
    per_episode_usdc: 0.6,
    utility_pool_usdc: 30,
    validator_fee_usdc: 5,
    treasury_fee_usdc: 5,
    license: "commercial_ai_training",
    deadline: NOW + 86_400,
    created_at: NOW,
    status: "open",
    ...overrides,
  };
}

function episode(overrides: Partial<EpisodeSubmission> = {}): EpisodeSubmission {
  return {
    episode_id: "ep_1",
    bounty_id: "bounty_typing_001",
    entity_id: "0xA1b2",
    manifest_hash: `0x${"11".repeat(32)}`,
    duration_s: 15,
    plausibility: 0.88,
    framing: 0.97,
    trust_level: "heuristic",
    ua_class: "android_chrome",
    recorded_at: NOW,
    ...overrides,
  };
}

describe("budgetBreakdown", () => {
  it("balances when every allocation is accounted for", () => {
    // 100 x 0.60 = 60, + 30 pool + 5 validator + 5 treasury = 100.
    const result = budgetBreakdown(bounty());
    expect(result.episodes).toBeCloseTo(60, 6);
    expect(result.balanced).toBe(true);
  });

  it("catches product-spec §7's example, which overspends its budget", () => {
    // The spec pairs a 40 USDC utility pool with 100 x 0.60 in per-episode
    // payments against a 100 USDC budget, leaving nothing for the validator
    // and treasury that §13 allocates 5% each.
    const result = budgetBreakdown(bounty({ utility_pool_usdc: 40 }));
    expect(result.allocated).toBeCloseTo(110, 6);
    expect(result.balanced).toBe(false);
  });
});

describe("meetsTrustLevel", () => {
  it("accepts an equal or stronger level", () => {
    expect(meetsTrustLevel("heuristic", "heuristic")).toBe(true);
    expect(meetsTrustLevel("attested", "heuristic")).toBe(true);
    expect(meetsTrustLevel("hardware", "self_reported")).toBe(true);
  });

  it("rejects a weaker level", () => {
    expect(meetsTrustLevel("self_reported", "heuristic")).toBe(false);
  });
});

describe("evaluateEpisode", () => {
  it("accepts a good episode and prices it at the flat rate", () => {
    const decision = evaluateEpisode(bounty(), episode());
    expect(decision.accepted).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.paid_usdc).toBeCloseTo(0.6, 6);
  });

  it("pays nothing for a rejected episode", () => {
    const decision = evaluateEpisode(bounty(), episode({ framing: 0.1 }));
    expect(decision.accepted).toBe(false);
    expect(decision.paid_usdc).toBe(0);
  });

  it("rejects poor framing with a reason that doesn't leak the confidential bar", () => {
    const decision = evaluateEpisode(bounty(), episode({ framing: 0.32 }));
    expect(decision.reasons.join(" ")).toMatch(/framed/i);
    expect(decision.reasons.join(" ")).not.toMatch(/32%|70%/);
  });

  it("rejects an episode whose motion match is too low, without leaking the confidential bar", () => {
    const decision = evaluateEpisode(bounty(), episode({ plausibility: 0.11 }));
    expect(decision.reasons.join(" ")).toMatch(/motion match/i);
    expect(decision.reasons.join(" ")).not.toMatch(/11%|70%/);
  });

  it("accepts an unscorable-motion episode when the bounty allows static tasks", () => {
    // Typing at a desk barely rotates the head: measured 0.8 deg/s on device.
    // Requiring the gyro check here would reject every honest submission.
    const decision = evaluateEpisode(bounty(), episode({ plausibility: null }));
    expect(decision.accepted).toBe(true);
  });

  it("rejects an unscorable-motion episode when the bounty requires the check", () => {
    const decision = evaluateEpisode(
      bounty({ motion_policy: "require" }),
      episode({ plausibility: null }),
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/too little head motion/i);
  });

  it("marks an accepted static episode as carrying no motion evidence", () => {
    const b = bounty();
    const e = episode({ plausibility: null });
    expect(evaluateEpisode(b, e).accepted).toBe(true);
    expect(lacksMotionEvidence(b, e)).toBe(true);
  });

  it("does not claim missing evidence when plausibility was actually measured", () => {
    expect(lacksMotionEvidence(bounty(), episode())).toBe(false);
  });

  it("rejects episodes shorter or longer than the bounty allows", () => {
    expect(evaluateEpisode(bounty(), episode({ duration_s: 3 })).reasons[0]).toMatch(/at least 8s/);
    expect(evaluateEpisode(bounty(), episode({ duration_s: 45 })).reasons[0]).toMatch(/at most 30s/);
  });

  it("rejects an episode below the required trust level", () => {
    const decision = evaluateEpisode(bounty(), episode({ trust_level: "self_reported" }));
    expect(decision.reasons.join(" ")).toMatch(/self_reported.*below.*heuristic/);
  });

  it("rejects a submission to a closed bounty", () => {
    const decision = evaluateEpisode(bounty({ status: "closed" }), episode());
    expect(decision.reasons.join(" ")).toMatch(/closed/i);
  });

  it("rejects an episode recorded after the deadline", () => {
    const decision = evaluateEpisode(bounty(), episode({ recorded_at: NOW + 200_000 }));
    expect(decision.reasons.join(" ")).toMatch(/deadline/i);
  });

  it("rejects when framing could not be measured at all", () => {
    const decision = evaluateEpisode(bounty(), episode({ framing: null }));
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/no frames were analysed/i);
  });

  it("reports every failure at once, not just the first", () => {
    const decision = evaluateEpisode(
      bounty(),
      episode({ duration_s: 2, framing: 0.1, plausibility: 0.1 }),
    );
    expect(decision.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
