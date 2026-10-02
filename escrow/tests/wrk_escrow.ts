import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createMint, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import { assert } from "chai";
import { WrkEscrow } from "../target/types/wrk_escrow";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const program = anchor.workspace.wrkEscrow as Program<WrkEscrow>;
const conn = provider.connection;
const sha = (s: string) => Array.from(createHash("sha256").update(s).digest());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PER = 600_000; // 0.6 tokens at 6 decimals

async function airdrop(k: PublicKey, sol = 5) {
  await conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
}

/** Expect a transaction to fail with a given Anchor error name or message fragment. */
async function fails(p: Promise<unknown>, fragment: string) {
  try {
    await p;
  } catch (e: any) {
    const text = `${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""} ${(e?.logs ?? []).join(" ")}`;
    assert.include(text, fragment, `failed, but not with "${fragment}": ${text.slice(0, 300)}`);
    return;
  }
  assert.fail(`expected failure containing "${fragment}"`);
}

describe("wrk_escrow", () => {
  const payer = (provider.wallet as anchor.Wallet).payer;
  const validator = Keypair.generate();
  let mint: PublicKey;
  let buyerToken: PublicKey;
  const buyer = Keypair.generate();

  before(async () => {
    await Promise.all([airdrop(payer.publicKey), airdrop(validator.publicKey), airdrop(buyer.publicKey)]);
    mint = await createMint(conn, payer, payer.publicKey, null, 6);
    buyerToken = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, buyer.publicKey)).address;
    await mintTo(conn, payer, mint, buyerToken, payer, 1_000_000_000);
  });

  type Ctx = { id: string; bounty: PublicKey; vault: PublicKey };

  /** A fresh task so tests never share state. */
  async function newBounty(opts: { per?: number; max?: number; deadlineIn?: number; grace?: number; fund?: number } = {}): Promise<Ctx> {
    const id = `bounty_${randomBytes(6).toString("hex")}`;
    const [bounty] = PublicKey.findProgramAddressSync([Buffer.from("bounty"), buyer.publicKey.toBuffer(), Buffer.from(sha(id))], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), bounty.toBuffer()], program.programId);
    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .createBounty(sha(id), validator.publicKey, new BN(opts.per ?? PER), opts.max ?? 5, new BN(now + (opts.deadlineIn ?? 3600)), new BN(opts.grace ?? 0))
      .accountsPartial({ payer: payer.publicKey, buyer: buyer.publicKey, mint, bounty, vault })
      .signers([payer, buyer])
      .rpc();
    if (opts.fund !== 0) await fund({ id, bounty, vault }, opts.fund ?? PER * 5);
    return { id, bounty, vault };
  }

  async function fund(c: Ctx, amount: number) {
    await program.methods.fundBounty(new BN(amount))
      .accountsPartial({ funder: buyer.publicKey, bounty: c.bounty, vault: c.vault, funderToken: buyerToken })
      .signers([buyer]).rpc();
  }

  async function submit(c: Ctx, contributor = Keypair.generate(), epId = `ep_${randomBytes(8).toString("hex")}`) {
    const [episode] = PublicKey.findProgramAddressSync([Buffer.from("episode"), c.bounty.toBuffer(), Buffer.from(sha(epId))], program.programId);
    const hash = Array.from(randomBytes(32));
    await program.methods.submitEpisode(sha(epId), hash)
      .accountsPartial({ payer: payer.publicKey, contributor: contributor.publicKey, bounty: c.bounty, vault: c.vault, episode })
      .signers([payer, contributor]).rpc();
    return { episode, contributor, epId, hash };
  }

  const accept = (c: Ctx, e: { episode: PublicKey; contributor: Keypair }, signer = validator, score = 8700) =>
    program.methods.acceptEpisode(score)
      .accountsPartial({
        validator: signer.publicKey, bounty: c.bounty, mint, vault: c.vault, episode: e.episode,
        contributor: e.contributor.publicKey,
        contributorToken: getAssociatedTokenAddressSync(mint, e.contributor.publicKey),
      })
      .signers([signer]).rpc();

  const reject = (c: Ctx, e: { episode: PublicKey }, signer = validator) =>
    program.methods.rejectEpisode(1200)
      .accountsPartial({ validator: signer.publicKey, bounty: c.bounty, episode: e.episode }).signers([signer]).rpc();

  const bal = async (a: PublicKey) => Number((await getAccount(conn, a)).amount);

  it("opens a task with an empty vault owned by the task, not by anyone's key", async () => {
    const c = await newBounty({ fund: 0 });
    const b = await program.account.bounty.fetch(c.bounty);
    assert.equal(b.buyer.toBase58(), buyer.publicKey.toBase58());
    assert.equal(b.validator.toBase58(), validator.publicKey.toBase58());
    assert.equal(b.perEpisode.toNumber(), PER);
    const v = await getAccount(conn, c.vault);
    assert.equal(v.owner.toBase58(), c.bounty.toBase58());
    assert.equal(Number(v.amount), 0);
  });

  it("refuses nonsense task settings", async () => {
    const mk = (per: number, max: number, deadlineIn: number, grace: number) => {
      const id = `bounty_${randomBytes(6).toString("hex")}`;
      const [bounty] = PublicKey.findProgramAddressSync([Buffer.from("bounty"), buyer.publicKey.toBuffer(), Buffer.from(sha(id))], program.programId);
      const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), bounty.toBuffer()], program.programId);
      return program.methods.createBounty(sha(id), validator.publicKey, new BN(per), max, new BN(Math.floor(Date.now() / 1000) + deadlineIn), new BN(grace))
        .accountsPartial({ payer: payer.publicKey, buyer: buyer.publicKey, mint, bounty, vault }).signers([payer, buyer]).rpc();
    };
    await fails(mk(0, 5, 3600, 0), "InvalidAmount");
    await fails(mk(PER, 0, 3600, 0), "InvalidCount");
    await fails(mk(PER, 5, -10, 0), "DeadlineInPast");
    await fails(mk(PER, 5, 3600, -1), "InvalidGrace");
    await fails(mk(PER, 5, 3600, 91 * 24 * 3600), "InvalidGrace");
  });

  it("takes funding from anyone and holds it in the vault", async () => {
    const c = await newBounty({ fund: 0 });
    await fund(c, 3_000_000);
    assert.equal(await bal(c.vault), 3_000_000);
    await fails(program.methods.fundBounty(new BN(0)).accountsPartial({ funder: buyer.publicKey, bounty: c.bounty, vault: c.vault, funderToken: buyerToken }).signers([buyer]).rpc(), "InvalidAmount");
  });

  it("records a take as pending and reserves its payout", async () => {
    const c = await newBounty();
    const e = await submit(c);
    const ep = await program.account.episode.fetch(e.episode);
    assert.deepEqual(Object.keys(ep.status), ["pending"]);
    assert.equal(ep.contributor.toBase58(), e.contributor.publicKey.toBase58());
    assert.deepEqual(Array.from(ep.manifestHash), e.hash);
    assert.equal((await program.account.bounty.fetch(c.bounty)).pending, 1);
    assert.equal(await bal(c.vault), PER * 5, "submitting must not move any money");
  });

  it("will not take the same take twice", async () => {
    const c = await newBounty();
    const e = await submit(c);
    await fails(submit(c, e.contributor, e.epId), "already in use");
  });

  it("accepts a take: pays exactly one per-take amount, creating the contributor's account", async () => {
    const c = await newBounty();
    const e = await submit(c);
    const ata = getAssociatedTokenAddressSync(mint, e.contributor.publicKey);
    assert.isNull(await conn.getAccountInfo(ata), "contributor starts with no token account");
    await accept(c, e);
    assert.equal(await bal(ata), PER);
    assert.equal(await bal(c.vault), PER * 4);
    const b = await program.account.bounty.fetch(c.bounty);
    assert.equal(b.pending, 0); assert.equal(b.accepted, 1);
    const ep = await program.account.episode.fetch(e.episode);
    assert.deepEqual(Object.keys(ep.status), ["accepted"]); assert.equal(ep.scoreBps, 8700);
  });

  it("can never pay a take twice", async () => {
    const c = await newBounty();
    const e = await submit(c);
    await accept(c, e);
    await fails(accept(c, e), "NotPending");
    await fails(reject(c, e), "NotPending");
    assert.equal(await bal(getAssociatedTokenAddressSync(mint, e.contributor.publicKey)), PER);
  });

  it("lets only the task's validator decide", async () => {
    const c = await newBounty();
    const e = await submit(c);
    const thief = Keypair.generate();
    await airdrop(thief.publicKey, 1);
    await fails(accept(c, e, thief), "ConstraintHasOne");
    await fails(reject(c, e, thief), "ConstraintHasOne");
    await fails(accept(c, e, buyer), "ConstraintHasOne"); // even the buyer can't pay out
    assert.equal(await bal(c.vault), PER * 5);
  });

  it("pays nothing on rejection and frees the reservation", async () => {
    const c = await newBounty();
    const e = await submit(c);
    await reject(c, e);
    assert.equal(await bal(c.vault), PER * 5);
    assert.equal((await program.account.bounty.fetch(c.bounty)).pending, 0);
    assert.deepEqual(Object.keys((await program.account.episode.fetch(e.episode)).status), ["rejected"]);
    await fails(accept(c, e), "NotPending");
  });

  it("only takes a submission the vault can cover, counting everything already reserved", async () => {
    const c = await newBounty({ fund: PER * 2 });
    await submit(c); await submit(c);
    await fails(submit(c), "Underfunded");
    await fund(c, PER);
    await submit(c); // now covered
  });

  it("stops at the number of takes the task asked for", async () => {
    const c = await newBounty({ max: 2 });
    const a = await submit(c); await submit(c);
    await fails(submit(c), "BountyFull");
    await reject(c, a); // a rejection frees a slot
    await submit(c);
  });

  it("will not accept a take recorded under a different task", async () => {
    const a = await newBounty(); const b = await newBounty();
    const e = await submit(a);
    await fails(
      program.methods.acceptEpisode(5000).accountsPartial({
        validator: validator.publicKey, bounty: b.bounty, mint, vault: b.vault, episode: e.episode,
        contributor: e.contributor.publicKey, contributorToken: getAssociatedTokenAddressSync(mint, e.contributor.publicKey),
      }).signers([validator]).rpc(),
      "ConstraintSeeds",
    );
  });

  it("pays the contributor recorded on the take, never a substitute", async () => {
    const c = await newBounty();
    const e = await submit(c);
    const other = Keypair.generate();
    await fails(
      program.methods.acceptEpisode(5000).accountsPartial({
        validator: validator.publicKey, bounty: c.bounty, mint, vault: c.vault, episode: e.episode,
        contributor: other.publicKey, contributorToken: getAssociatedTokenAddressSync(mint, other.publicKey),
      }).signers([validator]).rpc(),
      "ConstraintAddress",
    );
  });

  it("rejects an out-of-range score", async () => {
    const c = await newBounty();
    const e = await submit(c);
    await fails(accept(c, e, validator, 10_001), "InvalidScore");
  });

  it("refuses new takes after the deadline", async () => {
    const c = await newBounty({ deadlineIn: 4 });
    await sleep(5500);
    await fails(submit(c), "BountyExpired");
  });

  it("returns only the unreserved funds to the buyer, and only after the deadline", async () => {
    const c = await newBounty({ deadlineIn: 6, max: 5 });
    const paid = await submit(c); await accept(c, paid);          // 1 paid
    await submit(c);                                              // 1 still pending → reserved
    const refund = () => program.methods.refundExpired()
      .accountsPartial({ buyer: buyer.publicKey, bounty: c.bounty, vault: c.vault, buyerToken }).signers([buyer]).rpc();

    await fails(refund(), "TooEarly");
    await sleep(7500);
    const before = await bal(buyerToken);
    await refund();
    // funded 5, paid 1, 1 reserved → 3 come back
    assert.equal(await bal(buyerToken) - before, PER * 3);
    assert.equal(await bal(c.vault), PER, "the pending take's reservation stays");
    await fails(refund(), "NothingToRefund");
  });

  it("lets nobody but the buyer refund", async () => {
    const c = await newBounty({ deadlineIn: 4 });
    await sleep(5500);
    const thief = Keypair.generate(); await airdrop(thief.publicKey, 1);
    const thiefToken = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, thief.publicKey)).address;
    await fails(
      program.methods.refundExpired().accountsPartial({ buyer: thief.publicKey, bounty: c.bounty, vault: c.vault, buyerToken: thiefToken }).signers([thief]).rpc(),
      "ConstraintHasOne",
    );
  });

  it("frees a take the validator never decided, only after the deadline plus grace", async () => {
    const c = await newBounty({ deadlineIn: 3, grace: 3 });
    const e = await submit(c);
    const expire = () => program.methods.expireEpisode()
      .accountsPartial({ buyer: buyer.publicKey, bounty: c.bounty, episode: e.episode }).signers([buyer]).rpc();
    await fails(expire(), "TooEarly");
    await sleep(7500);
    await expire();
    assert.equal((await program.account.bounty.fetch(c.bounty)).pending, 0);
    assert.deepEqual(Object.keys((await program.account.episode.fetch(e.episode)).status), ["expired"]);
    await fails(expire(), "NotPending");
    // and the whole balance is now refundable
    const before = await bal(buyerToken);
    await program.methods.refundExpired().accountsPartial({ buyer: buyer.publicKey, bounty: c.bounty, vault: c.vault, buyerToken }).signers([buyer]).rpc();
    assert.equal(await bal(buyerToken) - before, PER * 5);
  });

  it("does not let a stranger expire someone else's pending take", async () => {
    const c = await newBounty({ deadlineIn: 3, grace: 0 });
    const e = await submit(c);
    await sleep(5000);
    await fails(
      program.methods.expireEpisode().accountsPartial({ buyer: validator.publicKey, bounty: c.bounty, episode: e.episode }).signers([validator]).rpc(),
      "ConstraintHasOne",
    );
  });
});
