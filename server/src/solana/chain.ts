import type { Bounty } from "@/lib/market/types";
import type { EscrowRef } from "./escrow";

export type { EscrowRef };

export interface EscrowInfo {
  exists: boolean;
  /** What is locked in the task's vault right now, in dollars. */
  vaultUsdc: number;
  pending: number;
  accepted: number;
  /** Unix seconds. */
  deadline: number;
}

/**
 * The only things the validator needs from Solana. Injected so tests never touch a network.
 *
 * Money moves only through the task's escrow: a contributor's take is recorded on-chain as pending, the validator
 * accepts it (releasing exactly one per-take amount from the task's vault) or rejects it (releasing the reservation).
 */
export interface ChainPort {
  cluster: string;
  /** The validator's address: the only key that can accept or reject a take, and the fee sponsor. */
  validator: string;

  // ---- a contributor's take -----------------------------------------------------------------------------------
  /** Records the take on-chain for an email account, whose key the server holds. Returns the signature. */
  anchor(a: { ref: EscrowRef; episodeId: string; manifestHash: string; signerSecret: Uint8Array }): Promise<string>;
  /** Same record, as a transaction for a contributor's own wallet to sign (base64, fees already covered). */
  buildAnchorTx(a: { ref: EscrowRef; episodeId: string; manifestHash: string; contributor: string }): Promise<string>;
  /** True when the take is on-chain for this contributor with exactly this manifest hash. */
  verifySubmission(a: { ref: EscrowRef; episodeId: string; manifestHash: string; contributor: string }): Promise<boolean>;
  /** Pays the contributor one per-take amount from the task's vault. Returns the signature. */
  accept(a: { ref: EscrowRef; episodeId: string; contributor: string; scoreBps: number }): Promise<string>;
  /** Refuses the take and frees its reservation. */
  reject(a: { ref: EscrowRef; episodeId: string; scoreBps: number }): Promise<string>;
  /** A plain transfer from the validator's treasury, used for reviewer fees. */
  pay(a: { contributor: string; amountUsdc: number; episodeId: string }): Promise<string>;

  // ---- a buyer's task -----------------------------------------------------------------------------------------
  /** Devnet only: test tokens for a buyer to fund their task with. */
  faucet(address: string, amountUsdc: number): Promise<string>;
  /** Opens and funds the task's escrow for a buyer whose key the server holds. */
  openEscrow(a: { bounty: Bounty; ref: EscrowRef; buyerSecret: Uint8Array }): Promise<string>;
  /** The same, as a transaction for a buyer's own wallet to sign. */
  buildOpenEscrowTx(a: { bounty: Bounty; ref: EscrowRef }): Promise<string>;
  escrow(ref: EscrowRef): Promise<EscrowInfo>;
  /** The address of the task's vault, so anyone can look at it on an explorer. Optional: test chains have none. */
  vaultAddress?(ref: EscrowRef): string;
  /** After the deadline: the buyer takes back what isn't reserved. */
  refund(a: { ref: EscrowRef; buyerSecret: Uint8Array }): Promise<string>;
  buildRefundTx(ref: EscrowRef): Promise<string>;
}
