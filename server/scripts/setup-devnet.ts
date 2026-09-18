/**
 * One-off: creates a devnet treasury key and a test reward token, funds the treasury, and writes server/.env.
 * Devnet only; the key lands in server/data (gitignored). Run: npx tsx scripts/setup-devnet.ts
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

const RPC = process.env.WRK_RPC_URL ?? "https://api.devnet.solana.com";
mkdirSync("data", { recursive: true });
const keyFile = "data/treasury.json";
const treasury = existsSync(keyFile)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8"))))
  : Keypair.generate();
if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify(Array.from(treasury.secretKey)), { mode: 0o600 });

const conn = new Connection(RPC, "confirmed");
console.log("Treasury:", treasury.publicKey.toBase58());

let bal = await conn.getBalance(treasury.publicKey);
for (let attempt = 0; bal < 0.5 * LAMPORTS_PER_SOL && attempt < 5; attempt++) {
  try {
    const sig = await conn.requestAirdrop(treasury.publicKey, 1 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  } catch (e) {
    console.log(`Airdrop attempt ${attempt + 1} failed: ${(e as Error).message.slice(0, 80)}`);
    await new Promise((r) => setTimeout(r, 4000));
  }
  bal = await conn.getBalance(treasury.publicKey);
}
console.log("Balance (SOL):", bal / LAMPORTS_PER_SOL);
if (bal < 0.05 * LAMPORTS_PER_SOL) {
  console.error("Could not fund the treasury from the devnet faucet. Fund it at https://faucet.solana.com and re-run.");
  process.exit(1);
}

const mint = await createMint(conn, treasury, treasury.publicKey, null, 6);
const ata = await getOrCreateAssociatedTokenAccount(conn, treasury, mint, treasury.publicKey);
await mintTo(conn, treasury, mint, ata.address, treasury, 10_000n * 1_000_000n);
console.log("Test reward token:", mint.toBase58());

writeFileSync(
  ".env",
  [
    `WRK_RPC_URL=${RPC}`,
    "WRK_CLUSTER=devnet",
    `WRK_MINT=${mint.toBase58()}`,
    `WRK_TREASURY_KEYPAIR=${process.cwd()}/${keyFile}`,
    "",
  ].join("\n"),
);
console.log("Wrote server/.env");
