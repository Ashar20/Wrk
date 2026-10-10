# Wrk — hackathon submission checklist

Results are announced November 10.

## What to build

| Requirement | Status | Evidence |
|---|---|---|
| Android only, functional APK | Done | Native Kotlin/Compose app. Debug and signed release builds exist. |
| Solana Mobile Stack and Mobile Wallet Adapter | Done | `mobile-wallet-adapter-clientlib-ktx` 2.0.3. Sign-in with an existing wallet, and wallet-signed escrow payouts ("Approve payout"). |
| Designed for mobile from the ground up | Done | Native CameraX video and 200 Hz motion capture, on-device hand tracking, hardware key attestation, coarse location. Not a PWA or a port. |
| Interacts meaningfully with Solana | Done | An Anchor escrow program on devnet. Each task's pay is locked in a vault, reserved on submit, and released only when the validator accepts. A rejected take refunds the reservation. See README, "Escrow". |

## What to submit

| Item | Status | What's left |
|---|---|---|
| Functional APK | Needs a rebuild | The release APK (`app/build/outputs/apk/release/app-release.apk`) was built Oct 8 and predates the trust score, live check and profile work. Rebuild it. |
| GitHub repository | Needs a push | Remote is `github.com/Ashar20/Wrk`; 13 commits are not pushed. Keys, `.env`, keystore and `server/data` are gitignored. Check the repo is public. |
| Demo video | Not made | Record from `DEMO.md`. See the suggested cut below. |
| Pitch deck | Not made | See the outline below. |

## Risks to fix before submitting

1. **Judges can't reach the validator.** `API_BASE` defaults to `http://127.0.0.1:8850`, which only works with `adb reverse` on your machine. A judge who installs the APK sees an empty app. Either host the validator (a small VPS or Fly.io is enough, with a stable HTTPS URL) and build the release with `-Pwrk.apiBase=https://…`, or say clearly in the README that the demo needs the local validator, and lean on the video.
2. **"Approve payout" with a wallet is not yet confirmed working on a phone.** Make sure it works once end to end before recording.
3. **Not yet tried on the phone by a person:** the live check, signed takes, the location prompt, the standalone live check, and the profile page.
4. **Devnet only.** Say so. The treasury and token are test assets.
5. **Don't show secrets on screen.** Keep `server/.env`, the keystore and treasury keys out of the video and the repo.

## Suggested demo video (about 3 minutes)

1. The problem in one line: people can be paid to capture first-person video and motion, but nobody can tell a real take from a replay.
2. Sign in with a wallet (MWA), then browse tasks with their pay.
3. Record a take. Show the hand skeleton, the framing meters and the live-check prompts.
4. The result card: "You earned $0.60", with a devnet receipt link.
5. The escrow: run `inspect-escrow.ts` before and after. `locked` drops by exactly the per-take pay.
6. The spoof: submit the replay fixture. It is refused, nothing is paid, and the reservation is released.
7. Verifier and buyer roles, briefly. Then the profile page with the trust score.

## Pitch deck outline

1. **Problem.** Robotics and world-model teams need real first-person data; collecting it is slow and easy to fake.
2. **Solution.** Wrk pays people from their phones. The pay is held in escrow and released only once the take is verified.
3. **How it's verified.** Motion and video must agree, the phone's key comes from secure hardware, and a live check asks for movements nobody could have pre-recorded.
4. **Why Solana and Mobile Wallet Adapter.** Escrow per task, sponsored fees, payouts approved from the user's own wallet app, and receipts anyone can verify.
5. **Anti-abuse.** One phone per account, a trust score that sets the daily cap, a location check on new accounts, and a cooldown on changes.
6. **Three roles.** Contributors, verifiers and buyers.
7. **Honest limits and roadmap.** Devnet only, and the world-model scoring is not built yet.
8. **Ask and team.**
