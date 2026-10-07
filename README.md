# Wrk

Wrk lets anyone with an Android phone complete a physical task, contribute video and motion data for robotics and AI, and get paid on Solana.

Record a short first-person clip, submit it, and Wrk checks that the video and your head movement agree. Accepted takes are paid out; the proof of submission is anchored on Solana.

## What's in this repo

| Path | What it is |
|---|---|
| `app/` | Native Android app (Kotlin, Jetpack Compose, CameraX, Mobile Wallet Adapter) |
| `server/` | Validator service: uploads, scoring, and the on-chain escrow client |
| `escrow/` | The Solana escrow program (Anchor): one vault per task, released only for accepted takes |
| `docs/` | Product spec and implementation plan |

## How a take flows

1. Pick a task and see what it pays. No account needed to browse.
2. Record 8–30 seconds. Video, audio and phone motion are captured together.
3. Review the take, say whether you finished the task, and submit. Set up a payment account if you haven't.
4. The app seals a manifest (SHA-256 over canonical JSON) and uploads it with the video and motion data.
5. The validator re-hashes everything, compares optical flow with gyroscope motion, and checks for duplicates.
6. The take is recorded in its task's on-chain escrow (with the manifest hash) before it can be paid. If it's accepted, exactly one per-take amount moves from the task's vault to the contributor; if not, the reservation is released.

### Three ways to use Wrk

Sign-in asks how you'll use it, and you can switch from your account any time.

- **Contributor:** record tasks and get paid, as above.
- **Verifier:** a queue of takes the automatic checks couldn't call. Watch the video, see the scores and motion traces, approve or reject. You're paid a small fee per decision from the task's reviewer pool. You can't review your own takes. Tasks opt in to this with "a person reviews close calls"; takes within 15 points of a task's bar wait for a verifier instead of being decided automatically.
- **Buyer:** post a task (name, instructions, pay per take, number of takes), watch accepted, rejected and in-review counts, score spread and spend, and share a dataset manifest of the accepted takes. The budget splits 60% takes, 30% bonus pool, 5% reviewers, 5% Wrk. Funding is simulated in this demo.

Verifier and Buyer need the validator to know who you are. Email accounts have that from sign-in; wallet users sign a one-time message once.

### Payment accounts

- **Email:** sign in with a code sent to your email. Wrk holds a payment account for you, anchors your takes, and covers fees. Nothing to install.
- **Your own wallet:** connect any Mobile Wallet Adapter wallet. It signs its own anchor transaction.

Wrk never asks for or stores a seed phrase. Email accounts are custodial: Wrk holds their keys (encrypted at rest) until withdrawals or a wallet provider are added.

## Run it

### Validator

```sh
cd server
npm install
npm run setup:devnet      # creates a devnet treasury + test reward token, writes .env
npm start                 # listens on :8850
```

If the devnet faucet rate-limits you, fund the treasury address it prints at https://faucet.solana.com and run the setup again.

Without `.env`, takes are still scored but never anchored or paid. Sign-in codes print to the server console unless `RESEND_API_KEY` and `WRK_MAIL_FROM` are set.

### App

```sh
adb reverse tcp:8850 tcp:8850       # debug builds talk to the validator on your laptop
./gradlew :app:installDebug
```

Release builds need an https validator: `./gradlew :app:assembleRelease -Pwrk.apiBase=https://your-validator`. Signing reads an untracked `keystore.properties`.

### Tests

```sh
cd server && npm test
./gradlew :app:testDebugUnitTest
```

## How the money is held

Every task has its own escrow on Solana (`escrow/`). A buyer locks the money for every take in the task's vault before the task opens, so contributors are never working against an empty promise.

- A take is recorded on-chain as pending, which **reserves** its payout. The vault must be able to cover every pending take.
- Only the validator's key can accept a take, which releases exactly one per-take amount to the contributor, or reject it, which releases the reservation. It can't pay a take twice, can't pay anyone but the contributor recorded on the take, and can't move money to itself.
- After a task's deadline the buyer takes back whatever isn't reserved. If the validator never decides a take, the buyer can expire it after a grace period, so funds can't be stuck.
- Reviewer fees are small direct transfers from the validator's treasury, not from a task's vault.

What this does **not** make trustless: whether a take deserves acceptance is the validator's judgement.

Program tests (a local validator, 19 tests): `escrow/scripts/local-validator.sh`, then in `escrow/` run `ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=keys/test-wallet.json npx ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts"`. Client tests against that chain: `WRK_LOCALNET=http://127.0.0.1:8899 npx vitest run test/escrow.chain.test.ts` in `server/`. Inspect a task on devnet: `npx tsx --env-file=.env scripts/inspect-escrow.ts bounty_004 [episodeId]`.

## Honest limits

- Validation is heuristic. It shows that video and motion agree, not that the scene was real. Takes are labelled `heuristic`, never `attested`.
- The validator decides what's accepted. The escrow limits what it can do with the money, not whether it judges well.
- On devnet the reward token is a free test token, and buyers are given test funds to lock up. Real funds would need a real mint and a real buyer deposit.
- Wallet users' transactions are built and fee-sponsored by the validator. A phone that asks for a transaction and never uploads has its reservation released after 30 minutes.
- Email accounts are custodial: Wrk holds their keys (encrypted) and there is no withdrawal yet.
- Raw video lives on the validator's disk; there's no content-addressed storage or deletion policy yet.
