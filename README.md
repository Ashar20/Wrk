# Wrk

Wrk lets anyone with an Android phone complete a physical task, contribute video and motion data for robotics and AI, and get paid on Solana.

Record a short first-person clip, submit it, and Wrk checks that the video and your head movement agree. Accepted takes are paid out; the proof of submission is anchored on Solana.

## What's in this repo

| Path | What it is |
|---|---|
| `app/` | Native Android app (Kotlin, Jetpack Compose, CameraX, Mobile Wallet Adapter) |
| `server/` | Validator service: uploads, scoring, Solana anchoring and payouts |
| `docs/` | Product spec and implementation plan |

## How a take flows

1. Pick a task and see what it pays. No account needed to browse.
2. Record 8–30 seconds. Video, audio and phone motion are captured together.
3. Review the take, say whether you finished the task, and submit. Set up a payment account if you haven't.
4. The app seals a manifest (SHA-256 over canonical JSON) and uploads it with the video and motion data.
5. The validator re-hashes everything, compares optical flow with gyroscope motion, and checks for duplicates.
6. A memo carrying the manifest hash is anchored on Solana, then accepted takes are paid in the reward token.

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
npm start                 # listens on :8787
```

If the devnet faucet rate-limits you, fund the treasury address it prints at https://faucet.solana.com and run the setup again.

Without `.env`, takes are still scored but never anchored or paid. Sign-in codes print to the server console unless `RESEND_API_KEY` and `WRK_MAIL_FROM` are set.

### App

```sh
adb reverse tcp:8787 tcp:8787       # debug builds talk to the validator on your laptop
./gradlew :app:installDebug
```

Release builds need an https validator: `./gradlew :app:assembleRelease -Pwrk.apiBase=https://your-validator`. Signing reads an untracked `keystore.properties`.

### Tests

```sh
cd server && npm test
./gradlew :app:testDebugUnitTest
```

## Honest limits

- Validation is heuristic. It shows that video and motion agree, not that the scene was real. Takes are labelled `heuristic`, never `attested`.
- Hand and object detection is not part of scoring.
- The on-chain side is a memo anchor plus an SPL token payout from a treasury. Custom escrow and registry programs are not built.
