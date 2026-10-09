import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOUNTIES } from "./bounties";
import type { Bounty } from "@/lib/market/types";

export interface NewBountyInput {
  title: string;
  task_spec: string;
  per_episode_usdc: number;
  min_episodes: number;
  review_policy?: "none" | "borderline";
  /** "attested" restricts the task to takes signed by a verified phone. */
  min_trust_level?: "heuristic" | "attested";
}

export class BountyInputError extends Error {}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * A bounty's money must add up (product-spec §13): per-take payments are 60%, with 30% for the utility pool,
 * 5% for validators and 5% for the treasury. Given what a buyer wants to pay and how many takes, this
 * produces the budget; the treasury share absorbs rounding so the total always balances to the cent.
 */
export function budgetFor(perEpisode: number, minEpisodes: number) {
  const episodes = cents(perEpisode * minEpisodes);
  const budget = cents(episodes / 0.6);
  const utility = cents(budget * 0.3);
  const validator = cents(budget * 0.05);
  const treasury = cents(budget - episodes - utility - validator);
  return { budget_usdc: budget, utility_pool_usdc: utility, validator_fee_usdc: validator, treasury_fee_usdc: treasury };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "task";

/** The seeded demo bounties plus whatever buyers have posted. Persisted as JSON beside the episodes. */
export class BountyStore {
  private custom: Bounty[] = [];
  private closed = new Set<string>();
  /** Escrow state per task id: who opened it and whether its vault is funded. */
  private escrows: Record<string, { buyer: string; funded: boolean }> = {};
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "bounties.json");
    if (existsSync(this.file)) {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      this.custom = j.custom ?? [];
      this.closed = new Set(j.closed ?? []);
      this.escrows = j.escrows ?? {};
    }
  }

  list(): Bounty[] {
    return [...BOUNTIES, ...this.custom].map((b) => ({
      ...b,
      ...(this.closed.has(b.bounty_id) ? { status: "closed" as const } : {}),
      ...(this.escrows[b.bounty_id] ? { escrow: this.escrows[b.bounty_id] } : {}),
    }));
  }

  /** Tasks contributors can see. With a chain, only once their vault is funded: nobody records takes against an empty promise. */
  open(chainOn: boolean): Bounty[] {
    return this.list().filter((b) => b.status === "open" && (!chainOn || b.escrow?.funded));
  }

  setEscrow(id: string, buyer: string, funded: boolean) {
    this.escrows[id] = { buyer, funded };
    this.flush();
  }

  markFunded(id: string) {
    const e = this.escrows[id];
    if (e && !e.funded) { e.funded = true; this.flush(); }
  }

  /** Drops a task that was posted but couldn't be set up. Seeded tasks are never removed. */
  discard(id: string) {
    this.custom = this.custom.filter((b) => b.bounty_id !== id);
    delete this.escrows[id];
    this.flush();
  }

  get(id: string) {
    return this.list().find((b) => b.bounty_id === id);
  }

  create(input: NewBountyInput, owner: string): Bounty {
    const title = input.title.trim();
    const spec = input.task_spec.trim();
    if (title.length < 3 || title.length > 80) throw new BountyInputError("Give the task a title between 3 and 80 characters.");
    if (spec.length < 10 || spec.length > 600) throw new BountyInputError("Describe what to do in 10 to 600 characters.");
    if (!(input.per_episode_usdc >= 0.1 && input.per_episode_usdc <= 20)) throw new BountyInputError("Pay between $0.10 and $20 per take.");
    if (!Number.isInteger(input.min_episodes) || input.min_episodes < 1 || input.min_episodes > 1000) throw new BountyInputError("Ask for between 1 and 1,000 takes.");
    const money = budgetFor(input.per_episode_usdc, input.min_episodes);
    const bounty: Bounty = {
      bounty_id: `bounty_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      title,
      task_spec: spec,
      task: slug(title),
      required_modalities: ["rgb", "imu"],
      min_episodes: input.min_episodes,
      duration_range_s: [8, 30],
      min_plausibility: 0.6,
      motion_policy: "require",
      min_framing: 0,
      min_trust_level: input.min_trust_level === "attested" ? "attested" : "heuristic",
      per_episode_usdc: cents(input.per_episode_usdc),
      ...money,
      license: "commercial_ai_training",
      deadline: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
      created_at: Math.floor(Date.now() / 1000),
      status: "open",
      owner,
      review_policy: input.review_policy === "borderline" ? "borderline" : "none",
    };
    this.custom.push(bounty);
    this.flush();
    return bounty;
  }

  close(id: string) {
    if (this.closed.has(id)) return;
    this.closed.add(id);
    this.flush();
  }

  private flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ custom: this.custom, closed: [...this.closed], escrows: this.escrows }));
    renameSync(tmp, this.file);
  }
}
