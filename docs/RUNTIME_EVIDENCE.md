# Mobile runtime evidence

Everything here was run on a physical phone, not an emulator, and the numbers are measured from the files the phone produced and the validator received. Nothing below comes from source reading alone.

## Device

| | |
|---|---|
| Phone | Samsung Galaxy A71 (SM-A715F) |
| OS | Android 13 (API 33) |
| IMU | TDK InvenSense ICM-4x6xx accelerometer and gyroscope |
| Camera | `camera.level.full` |
| Keystore | `hardware_keystore` feature level 4 |
| App | Wrk release/debug builds from this repo, talking to the validator over USB (`adb reverse`) and, for the release APK, to `wrk-validator.onrender.com` |

## Measured from real takes (CameraX capture, 200 Hz sensors)

Each row is a take recorded on the phone by the app, uploaded through the background worker, scored by the validator and paid on devnet. Rates are computed from the stored `imu.bin` (sample count over the recorded time span) and `ffprobe` on the stored video.

| Take | IMU samples | Span | IMU rate | Video | Motion match | Hands in view | Task |
|---|---|---|---|---|---|---|---|
| `…c13a24e6` | 6,075 | 30.2 s | 200.8 Hz | 720×1280 H.264, 28.6 fps | 0.789 | 85% | bounty_004 (auto-accepted) |
| `…9981e8f5` | 6,096 | 30.3 s | 200.8 Hz | 720×1280 H.264, 28.2 fps | 0.721 | 94% | bounty_004 (auto-accepted) |
| `…77b232d8` | 6,077 | 30.3 s | 200.8 Hz | 720×1280 H.264, 28.6 fps | 0.768 | 59% | bounty_004 (auto-accepted) |
| `…0346cbf3` | 6,086 | 30.3 s | 200.8 Hz | 720×1280 H.264, 28.1 fps | 0.776 | 69% | bounty_007 (approved by a verifier) |

All four are `attested` (signed by the phone's hardware-backed key) and were recorded on Solana before payment.

## Feature by feature

| Feature | Evidence |
|---|---|
| CameraX capture | 720×1280 H.264 files at about 28 fps recorded by the app (table above). |
| 200 Hz sensors | 6,075 to 6,096 gyroscope and accelerometer samples over about 30 s, 200.8 Hz effective, at the sensor rate Android allows for a normal app. |
| MediaPipe hand tracking | Runs on the phone during capture (skeleton overlay and framing meters). The validator independently computes hands-in-view from the video (59% to 94% above), which is a separate check. A screen recording of the overlay is in the demo video. |
| Wallet flow | Phantom signs in over Mobile Wallet Adapter (two wallet accounts, `4FhN…XZ4K` and `5Y13…2DSy`). The validator then records each take on-chain for the signed-in wallet. Example: [take recorded](https://explorer.solana.com/tx/3QLvQ74R4LF2xyxNxd55DnfTsXvDby1deqkYouwo2HvUfNDQeFnYvebUHvRap4PvukW84KYmUNQYp51fkaEqRdZJ?cluster=devnet), [payment](https://explorer.solana.com/tx/3RhcXqR35EX7dFdcZqtjYosbBNnCKwdUYkDYPXAdzhzadxka63yKjpUUtTue8r4ehEf2ZF3JA8sQ7XZMPK3c1CLx?cluster=devnet). |
| Background upload | The takes above were uploaded by WorkManager's `UploadWorker` (`Worker result SUCCESS` in logcat) and then scored and settled without the app in the foreground. |
| Role switching | The same phone acted as a contributor (`4FhN…`), a verifier (`5Y13…` approved take `…0346cbf3`, [payment](https://explorer.solana.com/tx/64jRWruNH58TLEYxfnMmaFPeCF1LQmiEvsbW5Yh7sRFFgc4Bo2X6KdhUpgaMBfdQPkGoZt9oDxSBNmDuUWVJgxJ6?cluster=devnet)) and a buyer (`5Y13…` posted "Water a houseplant" at 40 SKR). |
| Hardware attestation | All four takes carry trust level `attested`. |

## What this does not cover

- No emulator run: a real phone was used.
- Only one phone model was tested.
- The release APK against the hosted validator was built and downloaded but not driven through a full take on the phone; the debug build against the local validator was.
- A screen recording of the on-device overlay and liveness prompts is part of the demo video, not this file.

