/**
 * Prints a task's escrow and, optionally, one take's on-chain record. Reads devnet using server/.env.
 *   npx tsx --env-file=.env scripts/inspect-escrow.ts <bountyId> [episodeId]
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { EscrowClient } from "../src/solana/escrow";

const [bountyId, episodeId] = process.argv.slice(2);
if (!bountyId) throw new Error("usage: inspect-escrow.ts <bountyId> [episodeId]");
const treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.WRK_TREASURY_KEYPAIR!, "utf8"))));
const client = new EscrowClient(new Connection(process.env.WRK_RPC_URL!, "confirmed"), process.env.WRK_MINT!, treasury);
const ref = { buyer: treasury.publicKey.toBase58(), bountyId };
const s = await client.state(ref);
console.log("escrow:", { address: client.bountyPda(ref).toBase58(), vault: client.vaultPda(ref).toBase58(), locked: await client.toUsd(s.vaultRaw), pending: s.pending, accepted: s.accepted, perTake: await client.toUsd(s.perEpisodeRaw), max: s.maxEpisodes });
if (episodeId) {
  const e: any = await (client.program.account as any).episode.fetch(client.episodePda(ref, episodeId));
  console.log("take:", { address: client.episodePda(ref, episodeId).toBase58(), contributor: e.contributor.toBase58(), status: Object.keys(e.status)[0], scoreBps: e.scoreBps, manifestHash: "0x" + Buffer.from(e.manifestHash).toString("hex") });
}
