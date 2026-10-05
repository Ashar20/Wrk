import anchorPkg from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import idl from "./wrk_escrow.idl.json";

// Anchor ships CommonJS; Node's ESM loader can only see its default export, so take the pieces from there.
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
type BN = InstanceType<typeof BN>;

/** Identifies a task's escrow: who opened it and the task's public id. Everything else is derived. */
export interface EscrowRef {
  buyer: string;
  bountyId: string;
}

export interface OpenArgs {
  ref: EscrowRef;
  perEpisodeRaw: bigint;
  maxEpisodes: number;
  /** Unix seconds. */
  deadline: number;
  graceSecs: number;
  /** Tokens to move into the vault in the same transaction (the buyer must already hold them). */
  fundRaw: bigint;
}

export interface EscrowState {
  exists: boolean;
  vaultRaw: bigint;
  pending: number;
  accepted: number;
  perEpisodeRaw: bigint;
  maxEpisodes: number;
  deadline: number;
  validator: string;
}

const sha = (s: string) => Array.from(createHash("sha256").update(s).digest());
const hexBytes = (h: string) => Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

/**
 * Everything that touches the escrow program. The validator key is the only one that can accept or reject a
 * take, and it also sponsors fees and rent so contributors and buyers need no SOL of their own.
 */
export class EscrowClient {
  readonly program: InstanceType<typeof Program>;
  readonly programId: PublicKey;
  readonly mint: PublicKey;

  constructor(
    readonly conn: Connection,
    mint: string,
    private readonly validator: Keypair,
  ) {
    this.program = new Program(idl as Idl, new AnchorProvider(conn, new Wallet(Keypair.generate()), { commitment: "confirmed" }));
    this.programId = this.program.programId;
    this.mint = new PublicKey(mint);
  }

  get validatorAddress() {
    return this.validator.publicKey.toBase58();
  }

  // ---- addresses ------------------------------------------------------------------------------------------------
  bountyPda(ref: EscrowRef) {
    return PublicKey.findProgramAddressSync([Buffer.from("bounty"), new PublicKey(ref.buyer).toBuffer(), Buffer.from(sha(ref.bountyId))], this.programId)[0];
  }
  vaultPda(ref: EscrowRef) {
    return PublicKey.findProgramAddressSync([Buffer.from("vault"), this.bountyPda(ref).toBuffer()], this.programId)[0];
  }
  episodePda(ref: EscrowRef, episodeId: string) {
    return PublicKey.findProgramAddressSync([Buffer.from("episode"), this.bountyPda(ref).toBuffer(), Buffer.from(sha(episodeId))], this.programId)[0];
  }

  private decimalsCache?: number;
  async decimals() {
    this.decimalsCache ??= (await getMint(this.conn, this.mint)).decimals;
    return this.decimalsCache;
  }
  async toRaw(usd: number) {
    return BigInt(Math.round(usd * 10 ** (await this.decimals())));
  }
  async toUsd(raw: bigint) {
    return Number(raw) / 10 ** (await this.decimals());
  }

  // ---- sending --------------------------------------------------------------------------------------------------
  private async fresh(ixs: TransactionInstruction[]) {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = this.validator.publicKey;
    tx.recentBlockhash = (await this.conn.getLatestBlockhash("confirmed")).blockhash;
    return tx;
  }

  /** Signed by the validator (fee payer) and any [signers], then sent and confirmed. */
  private async send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
    const tx = await this.fresh(ixs);
    tx.sign(this.validator, ...signers);
    return sendAndConfirmRawTransaction(this.conn, tx.serialize(), { commitment: "confirmed" });
  }

  /** Signed only by the fee payer; the person whose key is still needed adds theirs in their wallet. */
  private async partial(ixs: TransactionInstruction[]) {
    const tx = await this.fresh(ixs);
    tx.partialSign(this.validator);
    return tx.serialize({ requireAllSignatures: false }).toString("base64");
  }

  // ---- test funds -----------------------------------------------------------------------------------------------
  /** Devnet only: mints test tokens to [address], creating its token account. The validator holds the mint authority. */
  async faucet(address: string, rawAmount: bigint) {
    const owner = new PublicKey(address);
    const ata = getAssociatedTokenAddressSync(this.mint, owner);
    return this.send([
      createAssociatedTokenAccountIdempotentInstruction(this.validator.publicKey, ata, owner, this.mint),
      createMintToInstruction(this.mint, ata, this.validator.publicKey, rawAmount),
    ]);
  }

  async tokenBalance(address: string): Promise<bigint> {
    try {
      return (await getAccount(this.conn, getAssociatedTokenAddressSync(this.mint, new PublicKey(address)))).amount;
    } catch {
      return 0n;
    }
  }

  // ---- opening and funding --------------------------------------------------------------------------------------
  private async openIxs(a: OpenArgs) {
    const buyer = new PublicKey(a.ref.buyer);
    const bounty = this.bountyPda(a.ref);
    const vault = this.vaultPda(a.ref);
    const create = await this.program.methods
      .createBounty(sha(a.ref.bountyId), this.validator.publicKey, new BN(a.perEpisodeRaw.toString()), a.maxEpisodes, new BN(a.deadline), new BN(a.graceSecs))
      .accountsPartial({ payer: this.validator.publicKey, buyer, mint: this.mint, bounty, vault })
      .instruction();
    const ixs = [create];
    if (a.fundRaw > 0n) {
      ixs.push(
        await this.program.methods
          .fundBounty(new BN(a.fundRaw.toString()))
          .accountsPartial({ funder: buyer, bounty, vault, funderToken: getAssociatedTokenAddressSync(this.mint, buyer) })
          .instruction(),
      );
    }
    return ixs;
  }

  /** The buyer is a key the server holds (the demo tasks, and email accounts). */
  async openEscrow(a: OpenArgs, buyerKey: Keypair) {
    return this.send(await this.openIxs(a), [buyerKey]);
  }

  /** The buyer holds their own key: returns a transaction for their wallet to sign and send. */
  async buildOpenEscrowTx(a: OpenArgs) {
    return this.partial(await this.openIxs(a));
  }

  async state(ref: EscrowRef): Promise<EscrowState> {
    const empty: EscrowState = { exists: false, vaultRaw: 0n, pending: 0, accepted: 0, perEpisodeRaw: 0n, maxEpisodes: 0, deadline: 0, validator: "" };
    const info = await this.conn.getAccountInfo(this.bountyPda(ref));
    if (!info) return empty;
    const b = (await (this.program.account as any).bounty.fetch(this.bountyPda(ref))) as {
      pending: number; accepted: number; perEpisode: BN; maxEpisodes: number; deadline: BN; validator: PublicKey;
    };
    const vault = await getAccount(this.conn, this.vaultPda(ref));
    return {
      exists: true, vaultRaw: vault.amount, pending: b.pending, accepted: b.accepted, perEpisodeRaw: BigInt(b.perEpisode.toString()),
      maxEpisodes: b.maxEpisodes, deadline: b.deadline.toNumber(), validator: b.validator.toBase58(),
    };
  }

  // ---- takes ----------------------------------------------------------------------------------------------------
  private async submitIx(ref: EscrowRef, episodeId: string, manifestHash: string, contributor: PublicKey) {
    const bounty = this.bountyPda(ref);
    return this.program.methods
      .submitEpisode(sha(episodeId), hexBytes(manifestHash))
      .accountsPartial({ payer: this.validator.publicKey, contributor, bounty, vault: this.vaultPda(ref), episode: this.episodePda(ref, episodeId) })
      .instruction();
  }

  /** The contributor is a key the server holds (email accounts). */
  async submit(ref: EscrowRef, episodeId: string, manifestHash: string, contributorKey: Keypair) {
    return this.send([await this.submitIx(ref, episodeId, manifestHash, contributorKey.publicKey)], [contributorKey]);
  }

  /** The contributor holds their own key: a transaction for their wallet, with fees and rent already covered. */
  async buildSubmitTx(ref: EscrowRef, episodeId: string, manifestHash: string, contributor: string) {
    return this.partial([await this.submitIx(ref, episodeId, manifestHash, new PublicKey(contributor))]);
  }

  /** True when the take is recorded on-chain for this contributor and exact manifest hash, and not yet decided against. */
  async verifySubmission(ref: EscrowRef, episodeId: string, manifestHash: string, contributor: string) {
    try {
      const e = (await (this.program.account as any).episode.fetch(this.episodePda(ref, episodeId))) as {
        contributor: PublicKey; manifestHash: number[]; status: Record<string, unknown>;
      };
      return (
        e.contributor.toBase58() === contributor &&
        Buffer.from(e.manifestHash).equals(Buffer.from(hexBytes(manifestHash))) &&
        !("expired" in e.status)
      );
    } catch {
      return false;
    }
  }

  async accept(ref: EscrowRef, episodeId: string, contributor: string, scoreBps: number) {
    const owner = new PublicKey(contributor);
    const ix = await this.program.methods
      .acceptEpisode(scoreBps)
      .accountsPartial({
        validator: this.validator.publicKey, bounty: this.bountyPda(ref), mint: this.mint, vault: this.vaultPda(ref),
        episode: this.episodePda(ref, episodeId), contributor: owner, contributorToken: getAssociatedTokenAddressSync(this.mint, owner),
      })
      .instruction();
    return this.send([ix]);
  }

  async reject(ref: EscrowRef, episodeId: string, scoreBps: number) {
    const ix = await this.program.methods
      .rejectEpisode(scoreBps)
      .accountsPartial({ validator: this.validator.publicKey, bounty: this.bountyPda(ref), episode: this.episodePda(ref, episodeId) })
      .instruction();
    return this.send([ix]);
  }

  // ---- refunds --------------------------------------------------------------------------------------------------
  private async refundIx(ref: EscrowRef) {
    const buyer = new PublicKey(ref.buyer);
    return this.program.methods
      .refundExpired()
      .accountsPartial({ buyer, bounty: this.bountyPda(ref), vault: this.vaultPda(ref), buyerToken: getAssociatedTokenAddressSync(this.mint, buyer) })
      .instruction();
  }
  async refund(ref: EscrowRef, buyerKey: Keypair) {
    return this.send([await this.refundIx(ref)], [buyerKey]);
  }
  async buildRefundTx(ref: EscrowRef) {
    return this.partial([await this.refundIx(ref)]);
  }
}
