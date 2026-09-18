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

Fallback if recording isn't possible: run the two fixture commands above and show the results.
