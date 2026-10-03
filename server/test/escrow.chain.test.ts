import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import { describe, expect, it, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { EscrowClient, type EscrowRef } from "../src/solana/escrow";

/**
 * Runs against a real local validator with the escrow program loaded:
 *   escrow/scripts/local-validator.sh   then   WRK_LOCALNET=http://127.0.0.1:8899 npx vitest run test/escrow.chain.test.ts
 * Skipped otherwise, so the normal suite never needs a chain.
 */
const RPC = process.env.WRK_LOCALNET;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RPC)("escrow client against a local chain", () => {
  const conn = new Connection(RPC ?? "http://127.0.0.1:8899", "confirmed");
  const validator = Keypair.generate();
  let client: EscrowClient;

  const airdrop = async (k: Keypair, sol = 5) => conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
  const hash = () => "0x" + randomBytes(32).toString("hex");
  const id = (p: string) => `${p}_${randomBytes(6).toString("hex")}`;

  async function funded(opts: { per?: number; max?: number; deadlineIn?: number; fund?: number } = {}) {
    const buyer = Keypair.generate();
    const ref: EscrowRef = { buyer: buyer.publicKey.toBase58(), bountyId: id("bounty") };
    const per = BigInt(opts.per ?? 600_000);
    const fund = BigInt(opts.fund ?? 3_000_000);
    await client.faucet(ref.buyer, fund);
    await client.openEscrow(
      { ref, perEpisodeRaw: per, maxEpisodes: opts.max ?? 5, deadline: Math.floor(Date.now() / 1000) + (opts.deadlineIn ?? 3600), graceSecs: 0, fundRaw: fund },
      buyer,
    );
    return { buyer, ref };
  }

  beforeAll(async () => {
    await airdrop(validator, 20);
    const mint = await createMint(conn, validator, validator.publicKey, null, 6);
    client = new EscrowClient(conn, mint.toBase58(), validator);
  });

  it("opens a task funded from the buyer's own tokens and reports what is locked", async () => {
    const { ref } = await funded();
    const s = await client.state(ref);
    expect(s).toMatchObject({ exists: true, vaultRaw: 3_000_000n, pending: 0, accepted: 0, perEpisodeRaw: 600_000n, maxEpisodes: 5 });
    expect(s.validator).toBe(client.validatorAddress);
    expect((await client.state({ ref: undefined, ...{ buyer: ref.buyer, bountyId: "nope" } } as unknown as EscrowRef)).exists).toBe(false);
  });

  it("records a take for a key the server holds, verifies it exactly, then pays on accept", async () => {
    const { ref } = await funded();
    const contributor = Keypair.generate();
    const ep = id("ep"), h = hash();
    await client.submit(ref, ep, h, contributor);
    const who = contributor.publicKey.toBase58();
    expect(await client.verifySubmission(ref, ep, h, who)).toBe(true);
    expect(await client.verifySubmission(ref, ep, hash(), who)).toBe(false); // different bytes
    expect(await client.verifySubmission(ref, ep, h, Keypair.generate().publicKey.toBase58())).toBe(false); // someone else's claim
    expect(await client.verifySubmission(ref, id("ep"), h, who)).toBe(false); // never submitted
    expect((await client.state(ref)).pending).toBe(1);

    await client.accept(ref, ep, who, 8700);
    expect(await client.tokenBalance(who)).toBe(600_000n);
    const s = await client.state(ref);
    expect(s).toMatchObject({ pending: 0, accepted: 1, vaultRaw: 2_400_000n });
  });

  it("cannot pay the same take twice, and a rejection pays nothing", async () => {
    const { ref } = await funded();
    const a = Keypair.generate(), b = Keypair.generate();
    const e1 = id("ep"), e2 = id("ep");
    await client.submit(ref, e1, hash(), a);
    await client.submit(ref, e2, hash(), b);
    await client.accept(ref, e1, a.publicKey.toBase58(), 9000);
    await expect(client.accept(ref, e1, a.publicKey.toBase58(), 9000)).rejects.toThrow();
    await client.reject(ref, e2, 1000);
    expect(await client.tokenBalance(b.publicKey.toBase58())).toBe(0n);
    expect(await client.tokenBalance(a.publicKey.toBase58())).toBe(600_000n);
    expect((await client.state(ref)).pending).toBe(0);
  });

  it("refuses a take the vault can't cover", async () => {
    const { ref } = await funded({ fund: 600_000 });
    await client.submit(ref, id("ep"), hash(), Keypair.generate());
    await expect(client.submit(ref, id("ep"), hash(), Keypair.generate())).rejects.toThrow();
  });

  it("builds a wallet transaction that the user's key completes, with no SOL from the user", async () => {
    const { ref } = await funded();
    const wallet = Keypair.generate(); // never airdropped: holds no SOL
    const ep = id("ep"), h = hash();
    const b64 = await client.buildSubmitTx(ref, ep, h, wallet.publicKey.toBase58());
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    expect(tx.feePayer!.toBase58()).toBe(client.validatorAddress);
    // the fee payer has already signed; the wallet adds its own signature and sends
    expect(tx.signatures.find((s) => s.publicKey.equals(tx.feePayer!))?.signature).toBeTruthy();
    expect(tx.signatures.find((s) => s.publicKey.equals(wallet.publicKey))?.signature).toBeFalsy();
    tx.partialSign(wallet);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, "confirmed");
    expect(await client.verifySubmission(ref, ep, h, wallet.publicKey.toBase58())).toBe(true);
  });

  it("builds a buyer's open-and-fund transaction for their wallet to sign", async () => {
    const buyer = Keypair.generate(); // no SOL either
    const ref: EscrowRef = { buyer: buyer.publicKey.toBase58(), bountyId: id("bounty") };
    await client.faucet(ref.buyer, 2_400_000n);
    const b64 = await client.buildOpenEscrowTx({ ref, perEpisodeRaw: 600_000n, maxEpisodes: 4, deadline: Math.floor(Date.now() / 1000) + 3600, graceSecs: 0, fundRaw: 2_400_000n });
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    tx.partialSign(buyer);
    await conn.confirmTransaction(await conn.sendRawTransaction(tx.serialize()), "confirmed");
    expect(await client.state(ref)).toMatchObject({ exists: true, vaultRaw: 2_400_000n, maxEpisodes: 4 });
  });

  it("refunds the buyer after the deadline, leaving what's reserved for pending takes", async () => {
    const { buyer, ref } = await funded({ deadlineIn: 6 });
    const c = Keypair.generate();
    const paid = id("ep");
    await client.submit(ref, paid, hash(), c);
    await client.accept(ref, paid, c.publicKey.toBase58(), 9000);
    await client.submit(ref, id("ep"), hash(), Keypair.generate()); // stays pending
    await expect(client.refund(ref, buyer)).rejects.toThrow(); // too early
    await sleep(8000);
    const before = await client.tokenBalance(ref.buyer);
    await client.refund(ref, buyer);
    expect((await client.tokenBalance(ref.buyer)) - before).toBe(3_000_000n - 600_000n - 600_000n);
    expect((await client.state(ref)).vaultRaw).toBe(600_000n);
  });
});
