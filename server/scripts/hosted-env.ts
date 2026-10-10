/** Writes server/hosted.env: the secrets a host without a disk needs (gitignored). Run: npx tsx scripts/hosted-env.ts */
import { readFileSync, writeFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const treasury = readFileSync(env.WRK_TREASURY_KEYPAIR, "utf8").trim();
const account = readFileSync("data/account.key", "utf8").trim();
writeFileSync("hosted.env", [`WRK_MINT=${env.WRK_MINT}`, `WRK_TREASURY_JSON=${treasury}`, `WRK_ACCOUNT_KEY=${account}`, `WRK_APP_CERT_SHA256=${env.WRK_APP_CERT_SHA256 ?? ""}`, ""].join("\n"), { mode: 0o600 });
console.log("Wrote server/hosted.env (do not commit or share)");
