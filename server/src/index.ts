import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { createHttpServer } from "./http";
import { Store } from "./store";
import { Accounts } from "./accounts";
import { BountyStore } from "./bountyStore";
import { ensureSeededEscrows } from "./escrowSeed";
import { ConsoleMailer, ResendMailer } from "./mailer";
import { SolanaChain } from "./solana/solana-chain";
import { createWorkerScorer } from "./scorer";

const port = Number(process.env.PORT ?? 8850);
const store = new Store(process.env.WRK_DATA_DIR ?? "data");

let chain: SolanaChain | null = null;
if (process.env.WRK_MINT && process.env.WRK_TREASURY_KEYPAIR) {
  const secret = Uint8Array.from(JSON.parse(readFileSync(process.env.WRK_TREASURY_KEYPAIR, "utf8")));
  chain = new SolanaChain({
    rpcUrl: process.env.WRK_RPC_URL ?? "https://api.devnet.solana.com",
    cluster: process.env.WRK_CLUSTER ?? "devnet",
    mint: process.env.WRK_MINT,
    treasury: Keypair.fromSecretKey(secret),
  });
} else {
  console.warn("WRK_MINT / WRK_TREASURY_KEYPAIR not set: episodes are scored but never anchored or paid.");
}

const dataDir = process.env.WRK_DATA_DIR ?? "data";
const mailer = process.env.RESEND_API_KEY && process.env.WRK_MAIL_FROM
  ? new ResendMailer(process.env.RESEND_API_KEY, process.env.WRK_MAIL_FROM)
  : new ConsoleMailer();
if (mailer instanceof ConsoleMailer) console.warn("RESEND_API_KEY not set: sign-in codes are printed here instead of emailed.");

const bounties = new BountyStore(dataDir);
if (chain) {
  const secret = Uint8Array.from(JSON.parse(readFileSync(process.env.WRK_TREASURY_KEYPAIR!, "utf8")));
  // In the background: tasks appear to contributors as their vaults finish opening.
  void ensureSeededEscrows(bounties, chain, secret);
}

createHttpServer({
  accounts: new Accounts(dataDir, mailer),
  bounties,
  store,
  chain,
  score: createWorkerScorer(),
  requireAnchor: process.env.WRK_REQUIRE_ANCHOR !== "0",
  validatorId: chain ? null : null,
})
  .on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(`Port ${port} is already used by another program. Stop it, or start the validator on another port with PORT=<number> (and point the app at it).`);
    else console.error(e);
    process.exit(1);
  })
  .listen(port, () => console.log(`Wrk validator listening on :${port}`));
