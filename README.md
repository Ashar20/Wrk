# Wrk

Wrk lets anyone with an Android phone complete a physical task, contribute video and motion data for robotics and AI, and get paid on Solana.

Record a short first-person clip, submit it, and Wrk checks that the video and your head movement agree. Accepted takes are paid out; the proof of submission is anchored on Solana.

Built for [CLOCK IN, the Solana Mobile Hackathon](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon) (with RadiantsDAO), and entered for the SKR integration prize. Submission details are in `SUBMISSION.md`.

## SKR integration

Every amount in Wrk is SKR, Solana Mobile's token. It isn't a payment option on the side: SKR is what the whole loop runs on.

- **Contributors are paid in SKR.** Each accepted take releases its pay (30 to 75 SKR on the demo tasks) from the task's escrow vault straight to the contributor's account.
- **Buyers fund tasks in SKR.** Posting a task locks the SKR for every take in an on-chain vault before the task opens, so the pay is there before anyone records.
- **Verifiers are paid in SKR**, 3 SKR per decision.
- **The app shows SKR everywhere:** task cards, the result card ("You earned 40 SKR"), profiles and the buyer dashboard.
- **Ready for mainnet SKR with one setting.** The escrow program works with any SPL token and reads the mint's decimals, and vaults are namespaced by mint, so switching `WRK_MINT` to the real SKR mint (`SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`) opens fresh vaults instead of colliding with the test ones. On devnet, where real SKR doesn't exist, Wrk uses a 6-decimal test token that behaves identically.

## What's in this repo

| Path | What it is |
|---|---|
| `app/` | Native Android app (Kotlin, Jetpack Compose, CameraX, Mobile Wallet Adapter) |
| `server/` | Validator service: uploads, scoring, and the on-chain escrow client |
| `escrow/` | The Solana escrow program (Anchor): one vault per task, released only for accepted takes |
| `docs/` | Hosting guide (`HOSTING.md`) and the implementation plan |
| `product-spec.md` | Product spec |
| `DEMO.md` | Demo script |
| `SUBMISSION.md` | Hackathon submission checklist |
| `render.yaml` | Render blueprint for hosting the validator |

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
- **Verifier:** a queue of takes the automatic checks couldn't call. Watch the video, see the scores and motion traces, approve or reject. You're paid a flat 3 SKR per decision from Wrk's treasury. You can't review your own takes. Tasks opt in to this with "a person reviews close calls"; takes within 15 points of a task's bar wait for a verifier instead of being decided automatically.
- **Buyer:** post a task (name, instructions, pay per take, number of takes), watch accepted, rejected and in-review counts, score spread and spend, and share a dataset manifest of the accepted takes. Posting a task locks the pay for every take in its on-chain escrow before it opens: email buyers get devnet test SKR and Wrk opens the escrow for them; wallet buyers sign the funding transaction themselves. The budget splits 60% takes, 30% bonus pool, 5% reviewers, 5% Wrk.
  The dashboard also shows what the data is worth to a world model: prediction error against the number of takes, and each contributor's share, measured by leaving them out and seeing how much worse the model gets (`GET /model`, from `server/model-results.json`).

Every role has a profile page with your name, trust score and history: your takes and earnings, your review decisions, or the tasks you've posted.

While you record, a small world model running on the validator shows its running guess of the next frame (`/predict`), and the guess can be replayed after the take.

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

### Hosting

To build an APK anyone can install, the validator needs a public https address. `docs/HOSTING.md` has the steps for both options:

- **Render** (free, no card): New, Blueprint, pick the repo, and it reads `render.yaml`. Free services have no disk, so secrets come from env vars instead of files: `WRK_MINT`, `WRK_TREASURY_JSON`, `WRK_ACCOUNT_KEY` and `WRK_APP_CERT_SHA256`, generated into an untracked `server/hosted.env` by `cd server && npx tsx scripts/hosted-env.ts`. Demo tasks reattach to their on-chain vaults at startup.
- **Fly.io**, with a persistent volume (`server/fly.toml`, `server/Dockerfile`).

Then build against it with `./gradlew :app:assembleRelease -Pwrk.apiBase=https://<your-host>`.

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
- **One phone, one payment account, with a cooldown.** A verified phone is linked to the first payment account that earns on it, and a payment account to the first phone it earns on. Switching sign-in, so a second account on the same phone or the same account on a second phone, is refused until a 7-day cooldown has passed. That is long enough to stop account-hopping and short enough for a genuine phone upgrade.
- **Many new accounts in one place share one allowance.** Each take carries an approximate location, rounded on the phone to about a kilometre and never a precise point. Brand-new accounts (fewer than 10 accepted takes, under two weeks old) within 1.5 km of each other are a group. Up to 3 are free, as a household or a few friends. More than 3 share one allowance of 5 takes a day, so adding phones and wallets in one spot gains nothing. Established accounts are never grouped, so real neighbours aren't punished. Mock locations are refused, and a location is required to earn (`WRK_REQUIRE_LOCATION=0` turns that off).
- **Earning needs a verified phone.** With Wrk's signing certificate configured, takes from unverified phones are refused (`WRK_REQUIRE_DEVICE=0` turns this off for development).
- **Phone registration is rate-limited**: five phones per hour from one source.
- **A trust score for every account (0 to 100).** Visible on the account screen with what it's made of, so people can see how to raise it:
  verified phone (+20), a passed live check (+15, valid 30 days), accepted takes (+3 each, up to 30), time on Wrk (+1 a day, up to 15), not being one of many new accounts in one spot (+10), steady sign-in (+10, lost for 30 days after switching phones or accounts), minus 4 per refused take (up to 30), 20 per copied take (up to 40) and 10 per failed live check (up to 30). A clean new account on a verified phone starts at 40.
  **The score sets the daily allowance.** Up to 40 gets the starting 5 takes a day; above that it climbs to 100 a day at a score of 100. Unverified phones and pooled new accounts stay at 5. Buyers see each contributor's score next to their takes in the dataset manifest.
- **A standalone live check anyone can run** (account screen, "Verify you're live"). A short recording with the same random head-movement prompts, signed by the verified phone, checked for the right movement at the right time in both the video and the phone's motion. It isn't a take: nothing is paid and the recording is discarded. Passing counts for 30 days; failing counts against the account. Five attempts an hour.
- **Live head-movement check (per task).** For each take the validator issues four random prompts at random moments ("turn your head left, then right", "nod up, then down"). The app shows them while recording and reports which it showed. The take must then show the right movement at the right time in both the video's motion and the phone's gyroscope. A recording made earlier can't, because nobody knew the sequence. It checks which axis moved, not which direction, so it doesn't depend on any phone's sign conventions. Measured against the real recordings in `server/test/fixtures`, none of 6,000 random challenges passed (`npx tsx scripts/liveness-false-accept.ts`).
- **Seeker is not required.** Solana Mobile's Seeker Genesis Token is a good extra signal but almost nobody has one, so Wrk doesn't depend on it.

What this does not stop: a person who buys several phones and spreads them far enough apart, or who wipes the app's data to get a fresh phone identity (Android gives apps no permanent hardware ID), can still start over. The cost is a slow ramp from 5 takes a day, a long link on each account, and the registration limit, which makes it expensive rather than impossible. Location is approximate and can be faked by someone with the skill to; it narrows the easy cases, it doesn't prove where anyone is. Hardware attestation shows a genuine phone running the genuine app, not that the camera saw a real scene. A determined attacker with a real phone, real motion and a screen could still try to game it. The live check raises the cost; it isn't proof.

## Honest limits

- Validation is heuristic. It shows that video and motion agree, not that the scene was real.
- The validator decides what's accepted. The escrow limits what it can do with the money, not whether it judges well.
- Pay is in SKR, Solana Mobile's token (a standard 6-decimal SPL token, mainnet mint `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`). SKR exists only on mainnet and only Solana Mobile can mint it, so on devnet Wrk uses a free test token that behaves identically and the app labels it SKR. Pointing the validator at the real mint is one setting (`WRK_MINT`), because the escrow program works with any SPL token and reads its decimals; mainnet would also need the escrow program deployed there and real SKR deposited by buyers. Amounts are set in SKR, not dollars. (Internal field names still end in `_usdc`.)
- Wallet users' transactions are built and fee-sponsored by the validator. A phone that asks for a transaction and never uploads has its reservation released after 30 minutes.
- Email accounts are custodial: Wrk holds their keys (encrypted) and there is no withdrawal yet.
- Raw video lives on the validator's disk; there's no content-addressed storage or deletion policy yet. On Render's free tier that disk is temporary: videos, tasks posted by buyers and email sign-ins are lost on restart.
- The world-model numbers come from a small model trained on 5 takes and tested on 1. At that size it doesn't yet beat the simple baseline; the curve is there to show how error falls as takes are added.
- The device and live checks are tested with synthetic chains and signals plus one real registration. They have not yet been run end to end with a person following the prompts on the phone.
