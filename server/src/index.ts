import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { createHttpServer } from "./http";
import { Store } from "./store";
import { SolanaChain } from "./solana/solana-chain";
import { scoreEpisode } from "@/lib/validator/score";

const port = Number(process.env.PORT ?? 8787);
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

createHttpServer({
  store,
  chain,
  score: scoreEpisode,
  requireAnchor: process.env.WRK_REQUIRE_ANCHOR !== "0",
  validatorId: chain ? null : null,
}).listen(port, () => console.log(`Wrk validator listening on :${port}`));
