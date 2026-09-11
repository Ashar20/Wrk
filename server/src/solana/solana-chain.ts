import {
  Connection,
  Keypair,
  PublicKey,
  type ParsedInstruction,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import type { ChainPort } from "./chain";

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export interface SolanaChainConfig {
  rpcUrl: string;
  cluster: string;
  mint: string;
  treasury: Keypair;
}

export class SolanaChain implements ChainPort {
  readonly cluster: string;
  private readonly conn: Connection;

  constructor(private readonly cfg: SolanaChainConfig) {
    this.cluster = cfg.cluster;
    this.conn = new Connection(cfg.rpcUrl, "confirmed");
  }

  async verifyMemo(signature: string, expected: { signer: string; memo: string }) {
    const tx = await this.conn.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err) return false;
    const signer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58();
    if (signer !== expected.signer) return false;
    const ixs = tx.transaction.message.instructions as Array<ParsedInstruction | PartiallyDecodedInstruction>;
    return ixs.some(
      (ix) =>
        ix.programId.toBase58() === MEMO_PROGRAM &&
        "parsed" in ix &&
        typeof ix.parsed === "string" &&
        ix.parsed === expected.memo,
    );
  }

  async pay({ contributor, amountUsdc }: { contributor: string; amountUsdc: number; episodeId: string }) {
    const mint = new PublicKey(this.cfg.mint);
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
