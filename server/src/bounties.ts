import type { Bounty } from "@/lib/market/types";

const IN_ONE_YEAR = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

const base = {
  required_modalities: ["rgb", "imu"] as Bounty["required_modalities"],
  min_episodes: 100,
  duration_range_s: [8, 30] as [number, number],
  // Measured: real recorded captures score ~0.70-0.71, a replay 0.04 (test/fixtures.score.test.ts).
  min_plausibility: 0.6,
  motion_policy: "require" as const,
  min_framing: 0,
  min_trust_level: "heuristic" as const,
  budget_usdc: 100,
  per_episode_usdc: 40,
  utility_pool_usdc: 30,
  validator_fee_usdc: 5,
  treasury_fee_usdc: 5,
  license: "commercial_ai_training",
  deadline: IN_ONE_YEAR,
  created_at: 1757030400,
  status: "open" as const,
  owner: "wrk",
  review_policy: "none" as const,
  liveness: "off" as const,
};

const SEEDS: Bounty[] = [
  {
    ...base,
    bounty_id: "bounty_004",
    title: "Cup pick-and-place, indoor",
    task_spec: "Pick up a cup from a surface, move it, and place it down. First-person view.",
    task: "cup_pick_and_place",
  },
  {
    ...base,
    bounty_id: "bounty_005",
    title: "Open a door and walk through",
    task_spec: "Open an interior door, walk through it and close it behind you. Keep your head turning naturally.",
    task: "door_walkthrough",
    per_episode_usdc: 55,
    budget_usdc: 120,
    utility_pool_usdc: 40,
    min_episodes: 100,
  },
  {
    ...base,
    bounty_id: "bounty_006",
    title: "Fold a towel",
    task_spec: "Fold a towel in half twice on a table, looking down at your hands the whole time.",
    task: "towel_fold",
    per_episode_usdc: 30,
    budget_usdc: 80,
    utility_pool_usdc: 20,
    min_episodes: 100,
  },
  {
    ...base,
    bounty_id: "bounty_007",
    title: "Cup pick-and-place, reviewed",
    task_spec: "Pick up a cup from a surface, move it, and place it down. First-person view. A person reviews every take before it is paid, so this one pays more.",
    task: "cup_pick_and_place",
    per_episode_usdc: 60,
    budget_usdc: 150,
    utility_pool_usdc: 45,
    validator_fee_usdc: 7.5,
    treasury_fee_usdc: 7.5,
    review_policy: "always",
  },
  {
    ...base,
    bounty_id: "bounty_008",
    title: "Cup pick-and-place, live check",
    task_spec: "Pick up a cup, move it, and place it down. While you work the app will ask you to look side to side and nod, a few seconds apart. This proves the recording is live, so it pays more.",
    task: "cup_pick_and_place",
    per_episode_usdc: 75,
    budget_usdc: 200,
    utility_pool_usdc: 60,
    validator_fee_usdc: 10,
    treasury_fee_usdc: 10,
    liveness: "require",
  },
];

const cents = (n: number) => Math.round(n * 100) / 100;

/** The money split follows from the pay and take count (60% takes, 30% bonus pool, 5% reviewers, 5% Wrk), as for any posted task. */
// The person-reviewed task leads the list: it is the one a demo of the whole flow starts from.
export const BOUNTIES: Bounty[] = [...SEEDS].sort((a, b) => Number(b.bounty_id === "bounty_007") - Number(a.bounty_id === "bounty_007")).map((b) => {
  const budget = cents((b.per_episode_usdc * b.min_episodes) / 0.6);
  const utility = cents(budget * 0.3);
  const validator = cents(budget * 0.05);
  return { ...b, budget_usdc: budget, utility_pool_usdc: utility, validator_fee_usdc: validator, treasury_fee_usdc: cents(budget - b.per_episode_usdc * b.min_episodes - utility - validator) };
});
