# Wrk — CLOCK IN submission checklist

[CLOCK IN](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon) is the Solana Mobile Hackathon, run with RadiantsDAO: a mobile-first app for Seeker, $125,000 in USDC across ten places, plus a separate $10,000 prize paid in SKR for a creative and meaningful SKR integration. Wrk is entered for both.

| Date | |
|---|---|
| Submissions opened | September 8, 2026 |
| Submissions closed | **October 8, 2026** |
| Winners announced | Early November 2026 |

Register and submit on the official CLOCK IN site (solanamobile.com/hackathon). Winners must publish on the Solana dApp Store to claim a prize; a timeframe is given after results.

## What to build

| Requirement | Status | Evidence |
|---|---|---|
| Android only, functional APK | Done | Native Kotlin/Compose app. Debug and signed release builds. |
| Solana Mobile Stack and Mobile Wallet Adapter | Done | `mobile-wallet-adapter-clientlib-ktx` 2.0.3. Sign-in with an existing wallet, wallet-signed task funding, and wallet-signed escrow payouts ("Approve payout"). |
| Designed for mobile from the ground up | Done | Native CameraX video and 200 Hz motion capture, on-device hand tracking, hardware key attestation, coarse location. Not a PWA or a port. |
| Interacts meaningfully with Solana | Done | An Anchor escrow program on devnet (`8swdg4fKWMoqhcNLW4CS9hLdararEUKbjA8yB5Z3n9Qd`). Each task's pay is locked in a vault, reserved on submit, and released only when the validator accepts. A rejected take refunds the reservation. See README, "How the money is held". |

## SKR integration prize

Wrk runs on SKR end to end. See README, "SKR integration".

- Contributors are paid in SKR per accepted take, from the task's escrow vault.
- Buyers lock SKR in escrow to open a task; verifiers earn 3 SKR per decision.
- Every amount in the app is shown in SKR.
- The escrow works with any SPL token and reads the mint's decimals, and vaults are namespaced by mint, so pointing `WRK_MINT` at mainnet SKR is one setting. Devnet uses a 6-decimal test token, because real SKR exists only on mainnet.

## How the judges score it

| Criterion | What Wrk shows |
|---|---|
| Stickiness and product-market fit | A daily reason to come back: tasks that pay SKR, an allowance that grows with your trust score, and a profile with your history. Real demand: robotics and world-model teams need first-person video and motion data. |
| User experience | Browse without an account, email sign-in with no wallet needed, a recording coach, and a clear result card with a receipt. |
| Innovation | Proof that a take is live: video and motion must agree, the phone's key comes from secure hardware, and random head-movement prompts can't be pre-recorded. Escrowed pay per take, released only when verified. |
| Presentation and demo | `DEMO.md` and the video cut below. |

## What to submit

| Item | Status | What's left |
|---|---|---|
| Functional APK | Needs a build | No release APK in `app/build/outputs/apk/release/`. Build it against the hosted validator: `./gradlew :app:assembleRelease -Pwrk.apiBase=https://<host>`. |
| GitHub repository | Pushed | `github.com/Ashar20/Wrk`, up to date with `main`. Keys, `.env`, `hosted.env`, keystore and `server/data` are gitignored. Check the repo is public. |
| Demo video | Not made | Record from `DEMO.md`. See the suggested cut below. |
| Pitch deck | Not made | See the outline below. |

## Risks to fix before submitting

1. **Judges can't reach the validator unless it's hosted.** `API_BASE` defaults to `http://127.0.0.1:8850`, which only works with `adb reverse`. Render (`render.yaml`) and Fly (`server/fly.toml`) are set up; see `docs/HOSTING.md`. Deploy, check `curl https://<host>/bounties` lists the tasks, then build the APK against it. On Render's free tier the first request after a sleep takes about 30 seconds, and tasks posted by buyers and email sign-ins are lost on restart.
2. **Email sign-in codes print to the server log** unless `RESEND_API_KEY` and `WRK_MAIL_FROM` are set. Set both, or tell judges to sign in with a wallet.
3. **`WRK_APP_CERT_SHA256` must include the release keystore's digest**, or phones won't count as running the genuine app and earning is refused.
4. **"Approve payout" with a wallet is not yet confirmed working on a phone.** Make sure it works once end to end before recording.
5. **Not yet tried on the phone by a person:** the live check, signed takes, the location prompt, the standalone live check, and the profile page.
6. **Devnet only.** Say so. The treasury and the SKR test token are test assets.
7. **Don't show secrets on screen.** Keep `server/.env`, `server/hosted.env`, the keystore and treasury keys out of the video and the repo.

## Suggested demo video (about 3 minutes)

1. The problem in one line: people can be paid to capture first-person video and motion, but nobody can tell a real take from a replay.
2. Sign in with a wallet (MWA), then browse tasks with their pay in SKR.
3. Record a take. Show the hand skeleton, the framing meters, the live-check prompts and the model's live guess.
4. The result card: "You earned 40 SKR", with a devnet receipt link.
5. The escrow: run `inspect-escrow.ts` before and after. `locked` drops by exactly the per-take pay.
6. The spoof: submit the replay fixture. It is refused, nothing is paid, and the reservation is released.
7. Verifier and buyer roles, briefly, including the world-model results on the buyer dashboard. Then the profile page with the trust score.

## Pitch deck outline

1. **Problem.** Robotics and world-model teams need real first-person data; collecting it is slow and easy to fake.
2. **Solution.** Wrk pays people in SKR from their phones. The pay is held in escrow and released only once the take is verified.
3. **How it's verified.** Motion and video must agree, the phone's key comes from secure hardware, and a live check asks for movements nobody could have pre-recorded.
4. **Why Solana, Seeker and SKR.** Escrow per task, sponsored fees, payouts approved from the user's own wallet app, receipts anyone can verify, and SKR as the currency for contributors, verifiers and buyers.
5. **Anti-abuse.** One phone per account, a trust score that sets the daily allowance, pooling for clusters of new accounts, and a cooldown on changes.
6. **Three roles.** Contributors, verifiers and buyers.
7. **What the data is worth.** The world-model results: error against number of takes, and each contributor's share.
8. **Honest limits and roadmap.** Devnet only; the world model is trained on 5 takes and doesn't yet beat the baseline; mainnet SKR and dApp Store publishing next.
9. **Ask and team.**
