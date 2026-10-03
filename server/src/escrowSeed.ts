import { BOUNTIES } from "./bounties";
import type { BountyStore } from "./bountyStore";
import type { ChainPort } from "./solana/chain";

/**
 * Wrk's demo tasks are opened and funded by the validator's own key, so they behave like any buyer's task: the money is
 * locked in a vault before anyone records a take. Idempotent; runs at startup and skips tasks already on-chain.
 */
export async function ensureSeededEscrows(
  bounties: BountyStore,
  chain: ChainPort,
  buyerSecret: Uint8Array,
  log: (msg: string) => void = console.log,
): Promise<void> {
  for (const b of BOUNTIES) {
    try {
      const ref = { buyer: chain.validator, bountyId: b.bounty_id };
      if (!(await chain.escrow(ref)).exists) {
        await chain.faucet(chain.validator, b.per_episode_usdc * b.min_episodes); // test tokens: the vault is funded from these
        await chain.openEscrow({ bounty: b, ref, buyerSecret });
        log(`Opened escrow for ${b.bounty_id}`);
      }
      bounties.setEscrow(b.bounty_id, chain.validator, true);
    } catch (e) {
      log(`Could not open escrow for ${b.bounty_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
