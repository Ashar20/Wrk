import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { createHttpServer } from "./http";
import { Store } from "./store";
import { Accounts } from "./accounts";
import { BountyStore } from "./bountyStore";
import { ensureSeededEscrows } from "./escrowSeed";
import { Devices } from "./attestation/devices";
import { fetchRevocations } from "./attestation/android";
import { ConsoleMailer, ResendMailer } from "./mailer";
import { SolanaChain } from "./solana/solana-chain";
import { createWorkerScorer } from "./scorer";

const port = Number(process.env.PORT ?? 8850);
const store = new Store(process.env.WRK_DATA_DIR ?? "data");

// Hosts without a persistent disk pass the treasury key as an environment secret; it is written where the loader expects it.
if (process.env.WRK_TREASURY_JSON) {
  const dir = process.env.WRK_DATA_DIR ?? "data";
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/treasury.json`;
  writeFileSync(file, process.env.WRK_TREASURY_JSON, { mode: 0o600 });
  process.env.WRK_TREASURY_KEYPAIR = file;
}

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
const allowedAppCerts = (process.env.WRK_APP_CERT_SHA256 ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const devices = new Devices(dataDir, { packageName: process.env.WRK_ANDROID_PACKAGE ?? "com.wrk.app", allowedAppCerts });
if (allowedAppCerts.length === 0) console.warn("WRK_APP_CERT_SHA256 not set: phones can register, but none will count as running the genuine app, so no take is 'attested'.");
// Google's list of revoked attestation certificates: refreshed in the background; a failed fetch just keeps the last one.
const refreshRevocations = () => fetchRevocations().then((r) => { devices.revoked = r; }).catch(() => undefined);
void refreshRevocations();
setInterval(refreshRevocations, 6 * 3600_000).unref();
if (chain) {
  const secret = Uint8Array.from(JSON.parse(readFileSync(process.env.WRK_TREASURY_KEYPAIR!, "utf8")));
  // In the background: tasks appear to contributors as their vaults finish opening.
  void ensureSeededEscrows(bounties, chain, secret);
}

createHttpServer({
  accounts: new Accounts(dataDir, mailer),
  bounties,
  devices,
  // Earning needs a verified phone by default (once Wrk's signing certificate is configured). WRK_REQUIRE_DEVICE=0 turns it off.
  requireDevice: process.env.WRK_REQUIRE_DEVICE ? process.env.WRK_REQUIRE_DEVICE === "1" : allowedAppCerts.length > 0,
  // Location (a ~1 km area) is needed to earn, like a verified phone. WRK_REQUIRE_LOCATION=0 turns it off.
  requireLocation: process.env.WRK_REQUIRE_LOCATION ? process.env.WRK_REQUIRE_LOCATION === "1" : undefined,
  store,
  chain,
  sponsorSecret: chain ? Uint8Array.from(JSON.parse(readFileSync(process.env.WRK_TREASURY_KEYPAIR!, "utf8"))) : undefined,
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
