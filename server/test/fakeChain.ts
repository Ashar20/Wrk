import { Keypair } from "@solana/web3.js";
import type { Bounty } from "@/lib/market/types";
import type { ChainPort, EscrowInfo, EscrowRef } from "../src/solana/chain";
import type { BountyStore } from "../src/bountyStore";
import { BOUNTIES } from "../src/bounties";

const key = (r: EscrowRef) => `${r.buyer}|${r.bountyId}`;

interface Vault { vault: number; pending: number; accepted: number; per: number; max: number; deadline: number }
interface Take { contributor: string; hash: string; status: "pending" | "accepted" | "rejected" }

/**
 * An in-memory stand-in that follows the escrow program's rules (reservations, one decision per take, the vault is the
 * only source of payouts), so the server's logic is tested against the same constraints the chain enforces.
 */
export class FakeChain implements ChainPort {
  cluster = "devnet";
  validator = Keypair.generate().publicKey.toBase58();
  vaults = new Map<string, Vault>();
  takes = new Map<string, Take>();
  /** Everything paid out to a person: contributors from a vault, and reviewers by direct transfer. */
  payouts: Array<{ contributor: string; amountUsdc: number; episodeId: string; kind: "escrow" | "fee" }> = [];
  rejected: string[] = [];
  anchored: Array<{ episodeId: string; contributor: string }> = [];
  faucets: Array<{ address: string; amountUsdc: number }> = [];
  failNextAnchor = false;

  private vaultOf(r: EscrowRef) {
    const v = this.vaults.get(key(r));
    if (!v) throw new Error("No escrow for this task.");
    return v;
  }

  /** What a contributor's own wallet does after the server hands it a transaction. */
  walletSubmit(ref: EscrowRef, episodeId: string, manifestHash: string, contributor: string) {
    this.submit(ref, episodeId, manifestHash, contributor);
  }

  private submit(ref: EscrowRef, episodeId: string, hash: string, contributor: string) {
    const v = this.vaultOf(ref);
    if (this.takes.has(`${key(ref)}|${episodeId}`)) throw new Error("already in use");
    if (v.accepted + v.pending >= v.max) throw new Error("BountyFull");
    if (v.vault < (v.pending + 1) * v.per) throw new Error("Underfunded");
    v.pending++;
    this.takes.set(`${key(ref)}|${episodeId}`, { contributor, hash, status: "pending" });
  }

  async anchor({ ref, episodeId, manifestHash, signerSecret }: Parameters<ChainPort["anchor"]>[0]) {
    if (this.failNextAnchor) { this.failNextAnchor = false; throw new Error("rpc down"); }
    const contributor = Keypair.fromSecretKey(signerSecret).publicKey.toBase58();
    this.submit(ref, episodeId, manifestHash, contributor);
    this.anchored.push({ episodeId, contributor });
    return `anchor-${this.anchored.length}`;
  }
  async anchorFor({ ref, episodeId, manifestHash, contributor }: Parameters<ChainPort["anchorFor"]>[0]) {
    this.submit(ref, episodeId, manifestHash, contributor);
    this.anchored.push({ episodeId, contributor });
    return `anchor-${this.anchored.length}`;
  }
  async buildAnchorTx(a: Parameters<ChainPort["buildAnchorTx"]>[0]) {
    return Buffer.from(JSON.stringify({ kind: "submit", ...a })).toString("base64");
  }
  async verifySubmission({ ref, episodeId, manifestHash, contributor }: Parameters<ChainPort["verifySubmission"]>[0]) {
    const t = this.takes.get(`${key(ref)}|${episodeId}`);
    return !!t && t.contributor === contributor && t.hash === manifestHash && t.status !== undefined;
  }
  async accept({ ref, episodeId, contributor }: Parameters<ChainPort["accept"]>[0]) {
    const v = this.vaultOf(ref);
    const t = this.takes.get(`${key(ref)}|${episodeId}`);
    if (!t || t.status !== "pending") throw new Error("NotPending");
    if (t.contributor !== contributor) throw new Error("ConstraintAddress");
    if (v.vault < v.per) throw new Error("Underfunded");
    v.vault -= v.per; v.pending--; v.accepted++; t.status = "accepted";
    this.payouts.push({ contributor, amountUsdc: v.per, episodeId, kind: "escrow" });
    return `accept-${this.payouts.length}`;
  }
  async reject({ ref, episodeId }: Parameters<ChainPort["reject"]>[0]) {
    const v = this.vaultOf(ref);
    const t = this.takes.get(`${key(ref)}|${episodeId}`);
    if (!t || t.status !== "pending") throw new Error("NotPending");
    v.pending--; t.status = "rejected"; this.rejected.push(episodeId);
    return `reject-${this.rejected.length}`;
  }
  async pay({ contributor, amountUsdc, episodeId }: Parameters<ChainPort["pay"]>[0]) {
    this.payouts.push({ contributor, amountUsdc, episodeId, kind: "fee" });
    return `pay-${this.payouts.length}`;
  }

  async faucet(address: string, amountUsdc: number) { this.faucets.push({ address, amountUsdc }); return `faucet-${this.faucets.length}`; }
  async openEscrow({ bounty, ref }: Parameters<ChainPort["openEscrow"]>[0]) { this.open(bounty, ref); return `open-${this.vaults.size}`; }
  async buildOpenEscrowTx({ bounty, ref }: Parameters<ChainPort["buildOpenEscrowTx"]>[0]) {
    return Buffer.from(JSON.stringify({ kind: "open", bounty: bounty.bounty_id, ref })).toString("base64");
  }
  /** The wallet sends the transaction it was given. */
  walletOpen(bounty: Bounty, ref: EscrowRef) { this.open(bounty, ref); }
  private open(b: Bounty, ref: EscrowRef) {
    this.vaults.set(key(ref), { vault: b.per_episode_usdc * b.min_episodes, pending: 0, accepted: 0, per: b.per_episode_usdc, max: b.min_episodes, deadline: b.deadline });
  }
  async escrow(ref: EscrowRef): Promise<EscrowInfo> {
    const v = this.vaults.get(key(ref));
    return v ? { exists: true, vaultUsdc: v.vault, pending: v.pending, accepted: v.accepted, deadline: v.deadline } : { exists: false, vaultUsdc: 0, pending: 0, accepted: 0, deadline: 0 };
  }
  refunds: EscrowRef[] = [];
  async refund({ ref }: Parameters<ChainPort["refund"]>[0]) {
    const v = this.vaultOf(ref);
    if (Date.now() / 1000 <= v.deadline) throw new Error("TooEarly");
    const refundable = v.vault - v.pending * v.per;
    if (refundable <= 0) throw new Error("NothingToRefund");
    v.vault -= refundable; this.refunds.push(ref); return `refund-${this.refunds.length}`;
  }
  async buildRefundTx(ref: EscrowRef) { return Buffer.from(JSON.stringify({ kind: "refund", ref })).toString("base64"); }

  /** Funds every demo task, the way the server does at startup with a real chain. */
  async seed(bounties: BountyStore) {
    for (const b of BOUNTIES) {
      const ref = { buyer: this.validator, bountyId: b.bounty_id };
      this.open(b, ref);
      bounties.setEscrow(b.bounty_id, this.validator, true);
    }
  }
}
