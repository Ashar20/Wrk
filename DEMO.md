# Demo script

Setup: validator running with devnet configured, phone connected, `adb reverse tcp:8787 tcp:8787`.

1. **Browse.** Open Wrk. Three tasks with what they pay. No prompts.
2. **Pick "Cup pick-and-place".** Show the reward, length and sensors.
3. **Set up payment.** Enter an email, type the code from the validator console (or inbox). No wallet app. Mention the wallet option.
4. **Record.** Three-second countdown, then 15 seconds. The coach asks you to turn your head if you're too still.
5. **Review and submit.** Preview the clip, answer "Did you finish?", submit.
6. **Watch it settle.** Sending, checking, payment, then a dark card with "You earned $0.60" and a receipt link.
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

Fallback if recording isn't possible: run the two fixture commands above and show the results.
