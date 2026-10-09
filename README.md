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

## Keeping abuse out

Accounts are free, so Wrk limits phones and proves takes are live, rather than trusting accounts.

- **Verified phones.** Each phone makes a key inside its secure hardware (Android Keystore, in the TEE or StrongBox where present) and sends the certificate chain the hardware produced. The validator checks that chain against Google's published attestation roots and its revocation list, that the key was made with the validator's one-time challenge, that it can sign, that the OS booted verified with a locked bootloader, and that the app is Wrk, signed with Wrk's certificate. Every take is then signed with that key. This needs no setup beyond listing Wrk's certificate fingerprints in `WRK_APP_CERT_SHA256`.
- **Trust levels.** A take signed by a fully verified phone is `attested`; anything else is `heuristic`. The validator decides this; the app can't claim it. A task can require verified phones.
- **Per-device limits.** A phone with no verification gets 5 takes a day per account. A verified phone starts at 20 a day, shared by every account used on it, earns 2 more per accepted take, loses 3 per refused one, and tops out at 100. More than 3 accounts on one phone is treated as farming and clamps it to 5.
- **Live head-movement check (per task).** For each take the validator issues four random prompts at random moments ("turn your head left, then right", "nod up, then down"). The app shows them while recording and reports which it showed. The take must then show the right movement at the right time in both the video's motion and the phone's gyroscope. A recording made earlier can't, because nobody knew the sequence. It checks which axis moved, not which direction, so it doesn't depend on any phone's sign conventions. Measured against the real recordings in `server/test/fixtures`, none of 6,000 random challenges passed (`npx tsx scripts/liveness-false-accept.ts`).
- **Seeker is not required.** Solana Mobile's Seeker Genesis Token is a good extra signal but almost nobody has one, so Wrk doesn't depend on it.

What this does not do: hardware attestation shows a genuine phone running the genuine app, not that the camera saw a real scene. A determined attacker with a real phone, real motion and a screen could still try to game it. The live check raises the cost; it isn't proof.

## Honest limits

- Validation is heuristic. It shows that video and motion agree, not that the scene was real.
- The validator decides what's accepted. The escrow limits what it can do with the money, not whether it judges well.
- On devnet the reward token is a free test token, and buyers are given test funds to lock up. Real funds would need a real mint and a real buyer deposit.
- Wallet users' transactions are built and fee-sponsored by the validator. A phone that asks for a transaction and never uploads has its reservation released after 30 minutes.
- Email accounts are custodial: Wrk holds their keys (encrypted) and there is no withdrawal yet.
- Raw video lives on the validator's disk; there's no content-addressed storage or deletion policy yet.
- The device and live checks are tested with synthetic chains and signals plus one real registration. They have not yet been run end to end with a person following the prompts on the phone.
