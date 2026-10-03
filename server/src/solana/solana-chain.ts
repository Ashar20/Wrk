import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getMint,
} from "@solana/spl-token";
import type { Bounty } from "@/lib/market/types";
import type { ChainPort, EscrowInfo, EscrowRef } from "./chain";
import { EscrowClient } from "./escrow";

/** Days a take may sit undecided after a task's deadline before its buyer can expire it. */
const GRACE_SECS = 7 * 24 * 3600;

export interface SolanaChainConfig {
  rpcUrl: string;
  cluster: string;
  mint: string;
  treasury: Keypair;
}

export class SolanaChain implements ChainPort {
  readonly cluster: string;
  readonly validator: string;
  readonly escrowClient: EscrowClient;
  private readonly conn: Connection;

  constructor(private readonly cfg: SolanaChainConfig) {
    this.cluster = cfg.cluster;
    this.conn = new Connection(cfg.rpcUrl, "confirmed");
    this.escrowClient = new EscrowClient(this.conn, cfg.mint, cfg.treasury);
    this.validator = this.escrowClient.validatorAddress;
  }

  private args(bounty: Bounty, ref: EscrowRef) {
    return async () => ({
      ref,
      perEpisodeRaw: await this.escrowClient.toRaw(bounty.per_episode_usdc),
      maxEpisodes: bounty.min_episodes,
      deadline: bounty.deadline,
      graceSecs: GRACE_SECS,
      // The task's takes are what the vault must cover; the bonus pool and fees are settled off the vault.
      fundRaw: await this.escrowClient.toRaw(bounty.per_episode_usdc * bounty.min_episodes),
    });
  }

  anchor = ({ ref, episodeId, manifestHash, signerSecret }: Parameters<ChainPort["anchor"]>[0]) =>
    this.escrowClient.submit(ref, episodeId, manifestHash, Keypair.fromSecretKey(signerSecret));
  buildAnchorTx = ({ ref, episodeId, manifestHash, contributor }: Parameters<ChainPort["buildAnchorTx"]>[0]) =>
    this.escrowClient.buildSubmitTx(ref, episodeId, manifestHash, contributor);
  verifySubmission = ({ ref, episodeId, manifestHash, contributor }: Parameters<ChainPort["verifySubmission"]>[0]) =>
    this.escrowClient.verifySubmission(ref, episodeId, manifestHash, contributor);
  accept = ({ ref, episodeId, contributor, scoreBps }: Parameters<ChainPort["accept"]>[0]) =>
    this.escrowClient.accept(ref, episodeId, contributor, scoreBps);
  reject = ({ ref, episodeId, scoreBps }: Parameters<ChainPort["reject"]>[0]) => this.escrowClient.reject(ref, episodeId, scoreBps);

  async faucet(address: string, amountUsdc: number) {
    return this.escrowClient.faucet(address, await this.escrowClient.toRaw(amountUsdc));
  }
  async openEscrow({ bounty, ref, buyerSecret }: Parameters<ChainPort["openEscrow"]>[0]) {
    return this.escrowClient.openEscrow(await this.args(bounty, ref)(), Keypair.fromSecretKey(buyerSecret));
  }
  async buildOpenEscrowTx({ bounty, ref }: Parameters<ChainPort["buildOpenEscrowTx"]>[0]) {
    return this.escrowClient.buildOpenEscrowTx(await this.args(bounty, ref)());
  }
  async escrow(ref: EscrowRef): Promise<EscrowInfo> {
    const s = await this.escrowClient.state(ref);
    return { exists: s.exists, vaultUsdc: await this.escrowClient.toUsd(s.vaultRaw), pending: s.pending, accepted: s.accepted, deadline: s.deadline };
  }
  refund = ({ ref, buyerSecret }: Parameters<ChainPort["refund"]>[0]) => this.escrowClient.refund(ref, Keypair.fromSecretKey(buyerSecret));
  buildRefundTx = (ref: EscrowRef) => this.escrowClient.buildRefundTx(ref);

  /** A direct transfer from the treasury: reviewer fees, which are not part of any task's vault. */
  async pay({ contributor, amountUsdc }: { contributor: string; amountUsdc: number; episodeId: string }) {
    const mint = this.escrowClient.mint;
    const owner = new PublicKey(contributor);
    const { decimals } = await getMint(this.conn, mint);
    const amount = BigInt(Math.round(amountUsdc * 10 ** decimals));
    const from = getAssociatedTokenAddressSync(mint, this.cfg.treasury.publicKey);
    const to = getAssociatedTokenAddressSync(mint, owner);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(this.cfg.treasury.publicKey, to, owner, mint),
      createTransferCheckedInstruction(from, mint, to, this.cfg.treasury.publicKey, amount, decimals),
    );
    return sendAndConfirmTransaction(this.conn, tx, [this.cfg.treasury]);
  }
}
