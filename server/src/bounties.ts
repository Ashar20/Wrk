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
  per_episode_usdc: 0.6,
  utility_pool_usdc: 30,
  validator_fee_usdc: 5,
  treasury_fee_usdc: 5,
  license: "commercial_ai_training",
  deadline: IN_ONE_YEAR,
  created_at: 1757030400,
  status: "open" as const,
};

export const BOUNTIES: Bounty[] = [
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
    per_episode_usdc: 0.8,
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
    per_episode_usdc: 0.5,
    budget_usdc: 80,
    utility_pool_usdc: 20,
    min_episodes: 100,
  },
];
