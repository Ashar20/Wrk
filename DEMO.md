# Demo script

Setup: validator running with devnet configured, phone connected, `adb reverse tcp:8850 tcp:8850`.

1. **Browse.** Open Wrk. Three tasks with what they pay. No prompts.
2. **Pick "Cup pick-and-place".** Show the reward, length and sensors.
3. **Set up payment.** Enter an email, type the code from the validator console (or inbox). No wallet app. Mention the wallet option.
4. **Record.** Three-second countdown, then 15 seconds. The coach asks you to turn your head if you're too still.
5. **Review and submit.** Preview the clip, answer "Did you finish?", submit.
6. **Watch it settle.** Sending, checking, payment, then a dark card with "You earned 40 SKR" and a receipt link.
7. **The spoof.** From a terminal:
   ```sh
   cd server
   npx tsx scripts/submit-fixture.ts test/fixtures/real                              # genuine: accepted
   npx tsx scripts/submit-fixture.ts test/fixtures/real --imu test/fixtures/real2    # replay: rejected
   ```
   The replay scores about 4% on motion match and is rejected with a plain-language reason. No payment.

## Verifier and buyer

8. **Verifier.** Sign in on a second phone (or sign out and back in) as a Verifier. The queue shows takes held for review; open one, watch it, check the scores and traces, approve. The contributor's phone moves from "a reviewer is checking" to paid, and the verifier sees the fee in History. Submit the real fixture to the reviewed task to get one in the queue:
   ```sh
   npx tsx scripts/submit-fixture.ts test/fixtures/real --bounty bounty_007
   ```
9. **Buyer.** Sign in as a Buyer, post a task, then open a task to see accepted, rejected and in-review counts, the score spread and spend. Share the dataset manifest once a take is accepted.

## The escrow

10. **Locked, then released.** Start the validator; it opens and funds each demo task's escrow on devnet. Show one:
    ```sh
    cd server && npx tsx --env-file=.env scripts/inspect-escrow.ts bounty_004
    ```
    `locked` equal to the task's full budget. Record and submit a take as a contributor, then run it again with the episode id: the take is `accepted` on-chain and `locked` has dropped by exactly the per-take pay. The contributor's balance rose by the same amount.
11. **A rejected take pays nothing.** Submit the replay fixture: it's refused, the vault is untouched, and its reservation is released.

## Proof it's a real phone, and live

12. **Verified phone.** Open Account: "This phone: Verified". The validator checked the key came from the phone's secure hardware, running the genuine app. Takes from it show "Signed by a verified phone" and trust level `attested` in the details.
13. **Live check.** Open "Cup pick-and-place, live check" ($1.20). While you work the app asks, a few seconds apart, to turn your head or nod. Stop is disabled until the checks are done. The result shows a "Live check" meter. Submit the replay fixture to the same task: it can't have followed a sequence nobody knew, so it's refused.
14. **Limits.** Without a verified phone an account is capped at 5 takes a day; a verified phone starts at 20 and grows with accepted takes.

Fallback if recording isn't possible: run the two fixture commands above and show the results.
