# Wrk Android MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native Android (Kotlin/Compose) app that records a head-mounted video+IMU episode, hashes and anchors it on Solana devnet via Mobile Wallet Adapter, uploads it to a validator service, and shows the verdict and payout receipt.

**Architecture:** `app/` is the native Android client (ports of the existing capture/manifest logic to Kotlin, byte-compatible with the existing TypeScript hashing). `server/` is a small Node/TypeScript validator service assembled from the already-working validator, analysis, manifest and IMU-codec modules (copied and rebranded, not rewritten), with the EVM chain edge replaced by Solana (Memo verification + SPL payout from a devnet treasury key). Custom Anchor programs are explicitly deferred (spec: "Earliest demo shortcut"; cut-order item 3).

**Tech Stack:** Kotlin 2.0.21, Jetpack Compose (BOM 2024.12.01), CameraX 1.4.x, SensorManager, WorkManager, Solana Mobile `mobile-wallet-adapter-clientlib-ktx:2.2.0`, `web3-solana:0.3.1`, `rpc-core:0.2.11`; server: Node 22, TypeScript, vitest, `@solana/web3.js`, `@solana/spl-token`, ffmpeg (already installed) for frame decode.

**Spec:** `/Users/silas/Wrk/product-spec.md` (design: `/Users/silas/worldmod/DESIGN.md`; source reference root: `/Users/silas/worldmod`)

## Global Constraints

- Native Android only: Kotlin + Jetpack Compose. No WebView, no PWA, no browser capture APIs.
- No private keys, seed phrases or Seed Vault integration in the app. Wallet access only through Mobile Wallet Adapter; MWA auth token stored securely.
- Public naming: every user-visible/on-chain/manifest/commit string says **Wrk** only. Memo prefix `wrk`. Manifest `client.type` = `android_native`. The old product name must not appear in app UI, memo text, manifest, upload labels, APK metadata, README, or commit messages. Developer-only source paths are allowed in `docs/` plan text only.
- Design system as-is from DESIGN.md: bone `#e9e9e6`, paper `#f6f6f4`, paper-sunk `#e2e2de`, ink `#0d0d0f`, mint `#c7e6da`/`#1d5b49`, lilac `#ded0f3`/`#5b3d8c`, butter `#f6dcab`/`#7a5013`; radii panel 30 / card 22 / inner 16 / pill 999; Manrope + Geist Mono; no gradients, no accent colours, no third shadow.
- Contributor language: "payment account" not wallet, "approve payout" not sign, "processing payment" not confirming, "view receipt" not hash; dollars first; no gas/SOL/devnet in main flow.
- Browse bounties before any wallet prompt; wallet asked only at submission.
- Episodes 10–30 s default (bounty may set 8–30). Raw media never goes on-chain; only hash + ids.
- Manifest hash must be byte-identical to the existing TS `manifestHash` (RFC 8785 canonical JSON, SHA-256, `0x` lowercase hex, `manifest_hash` excluded from preimage). IMU stream uses the existing binary layout (`WMIMU1`, little-endian, 28 B/sample).
- Scoring semantics unchanged (optical flow vs gyro correlation); only interfaces change.
- minSdk 26, compileSdk/targetSdk 36 (existing scaffold). Cluster: Solana **devnet**.
- Trust level produced: `heuristic`.

## Review Focus

- Camera/mic/sensor permission denied or "don't ask again": app must explain and offer settings, never crash or record silently without sensors.
- Device with no gyroscope: block capture with a clear message (cross-modal check is impossible) rather than uploading an unscorable episode.
- No MWA-compatible wallet installed: `Set up payment account` path, not a crash; browsing still works.
- User cancels/declines wallet approval: episode stays queued locally, no data lost, retry offered.
- Recording shorter than the bounty minimum or longer than max: rejected on-device with coaching copy.
- Upload interrupted / offline / app killed mid-upload: episode survives on disk and resumes; resubmitting the same episode is idempotent (no double payout).
- Rejected or failed-scoring episode must never trigger a payout; accepted one pays exactly once.
- Number formatting differences between Kotlin and ECMAScript (e.g. `17.2`, `0.1`, `1e-7`, `-0`) must not change the manifest hash.
- Screen rotation/process death during recording does not corrupt the episode folder.

---

## File Structure

```
app/src/main/java/com/wrk/app/
  MainActivity.kt                  entry, nav host
  design/Theme.kt, Color.kt, Type.kt, Components.kt   DESIGN.md tokens + KnobBar, Chip, Card, Dock, Figure
  data/Bounty.kt, BountyRepository.kt                 bounty model + feed (static seed, then server)
  episode/CanonicalJson.kt         RFC 8785 serializer
  episode/ImuCodec.kt              WMIMU1 encode/decode
  episode/Manifest.kt              manifest model -> JsonObject, hash, seal
  episode/EpisodeBuilder.kt        RawCapture -> sealed manifest + files
  episode/EpisodeStore.kt          on-disk episode folders + status JSON
  capture/ImuRecorder.kt           SensorManager recorder, monotonic timestamps
  capture/VideoRecorder.kt         CameraX video recording
  capture/CaptureController.kt     orchestrates both, produces RawCapture
  wallet/WalletManager.kt          MWA connect/reauthorize/sign+send, token store
  wallet/MemoTx.kt                 builds the Memo transaction
  upload/UploadWorker.kt, ApiClient.kt   queue + multipart upload + status polling
  ui/HomeScreen.kt, BountyDetailScreen.kt, CaptureScreen.kt, ReviewScreen.kt, SubmissionScreen.kt, ResultScreen.kt
app/src/test/java/com/wrk/app/...  JVM unit tests (golden vectors)
server/
  src/lib/{manifest,capture,validator,analysis}   ported modules (+ tests)
  src/solana/{verifyMemo.ts,payout.ts}
  src/http.ts, src/store.ts, src/bounties.ts, src/index.ts
  test/fixtures/{real,replay}/                     seeded captures
scripts/gen-golden.mjs             emits golden vectors from the TS implementation
```

---

### Task 1: Rebrand scaffold to Wrk, theme tokens, git init

**Files:**
- Modify: `settings.gradle.kts`, `app/build.gradle.kts`, `app/src/main/AndroidManifest.xml`, `app/src/main/res/values/{strings,themes}.xml`
- Move: `app/src/main/java/com/example/hello/MainActivity.kt` → `app/src/main/java/com/wrk/app/MainActivity.kt`
- Create: `app/src/main/java/com/wrk/app/design/{Color,Type,Theme}.kt`, `app/src/main/res/font/` (Manrope, GeistMono ttf)

**Interfaces:**
- Produces: `WrkTheme { }` composable; `object WrkColors { bone, paper, paperSunk, ink, inkRaised, foreground, muted, subtle, onInk, onInkMuted, mint, mintInk, lilac, lilacInk, butter, butterInk, positive, caution, negative }` (all `Color`); `object WrkShape { panel=30.dp, card=22.dp, inner=16.dp }`.

- [ ] **Step 1:** `git init` in `/Users/silas/Wrk`; extend `.gitignore` with `server/node_modules`, `*.keystore`, `server/.env`, `server/data/`.
- [ ] **Step 2:** Rename `rootProject.name = "Wrk"`, namespace/applicationId `com.wrk.app`, strings `app_name=Wrk`, theme `Theme.Wrk`; move MainActivity to the new package.
- [ ] **Step 3:** Download Manrope and Geist Mono (OFL) into `res/font/` (lowercase file names), and write `Color.kt`/`Type.kt`/`Theme.kt` with the DESIGN.md hex values; type scale: figure-hero 52/600/-0.035em tabular, title 19, body 14/1.625, label 11/500, data = Geist Mono 12.
- [ ] **Step 4:** MainActivity renders `WrkTheme { Box(bg = bone) { Text("Wrk") } }`.
- [ ] **Step 5:** Run `./gradlew :app:assembleDebug` — Expected: BUILD SUCCESSFUL. Install: `adb install -r app/build/outputs/apk/debug/app-debug.apk` and launch `adb shell am start -n com.wrk.app/.MainActivity`.
- [ ] **Step 6:** Commit `feat: scaffold Wrk Android app with design tokens`.

### Task 2: Canonical JSON (RFC 8785) in Kotlin with golden vectors

**Files:**
- Create: `scripts/gen-golden.mjs`, `app/src/test/resources/golden/canonical.json`, `app/src/main/java/com/wrk/app/episode/CanonicalJson.kt`, `app/src/test/java/com/wrk/app/episode/CanonicalJsonTest.kt`
- Modify: `app/build.gradle.kts` (add `testImplementation("junit:junit:4.13.2")`, `org.json:json:20240303` for tests)

**Interfaces:**
- Produces: `sealed interface Json`; `JsonObj(val map: Map<String, Json>)`, `JsonArr(val items: List<Json>)`, `JsonStr`, `JsonNum(val value: Double)`, `JsonBool`, `JsonNull`; `fun canonicalize(v: Json): String`; `fun canonicalBytes(v: Json): ByteArray`.

- [ ] **Step 1:** `scripts/gen-golden.mjs` imports `canonicalize` from `/Users/silas/worldmod/web/src/lib/manifest/canonicalize.ts` (run with `npx tsx`) over a fixed list of values: nested objects with unsorted keys, `17.2`, `0.1`, `1`, `-0`, `1e21`, `1e-7`, `123456789.125`, strings with `"`, `\n`, `\u0001`, `é`, `😀`, empty object/array, and writes `{input, expected}` pairs to `canonical.json`. Run it and commit the output.
- [ ] **Step 2:** Write `CanonicalJsonTest` that loads every pair, builds `Json` from the input via a tiny converter, and asserts `canonicalize(...) == expected`. Run `./gradlew :app:testDebugUnitTest --tests '*CanonicalJsonTest'` → FAIL (class missing).
- [ ] **Step 3:** Implement `CanonicalJson.kt`:

```kotlin
package com.wrk.app.episode

import java.math.BigDecimal

sealed interface Json
data class JsonObj(val map: Map<String, Json>) : Json
data class JsonArr(val items: List<Json>) : Json
data class JsonStr(val value: String) : Json
data class JsonNum(val value: Double) : Json
data class JsonBool(val value: Boolean) : Json
object JsonNull : Json

private fun number(v: Double): String {
    require(v.isFinite()) { "Cannot canonicalize non-finite number: $v" }
    if (v == 0.0) return "0" // also covers -0
    val abs = Math.abs(v)
    require(abs < 1e21 && abs >= 1e-6 || abs == 0.0) { "Exponent form not supported: $v" }
    return BigDecimal(v.toString()).stripTrailingZeros().toPlainString()
}

private fun str(s: String): String {
    val sb = StringBuilder("\"")
    for (c in s) when {
        c == '"' -> sb.append("\\\"")
        c == '\\' -> sb.append("\\\\")
        c == '\b' -> sb.append("\\b")
        c == '\t' -> sb.append("\\t")
        c == '\n' -> sb.append("\\n")
        c == '\u000C' -> sb.append("\\f")
        c == '\r' -> sb.append("\\r")
        c < ' ' -> sb.append(String.format("\\u%04x", c.code))
        else -> sb.append(c)
    }
    return sb.append('"').toString()
}

fun canonicalize(v: Json): String = when (v) {
    JsonNull -> "null"
    is JsonBool -> v.value.toString()
    is JsonNum -> number(v.value)
    is JsonStr -> str(v.value)
    is JsonArr -> v.items.joinToString(",", "[", "]") { canonicalize(it) }
    // Kotlin String.compareTo is UTF-16 code-unit order, matching JCS.
    is JsonObj -> v.map.entries.sortedWith { a, b -> a.key.compareTo(b.key) }
        .joinToString(",", "{", "}") { "${str(it.key)}:${canonicalize(it.value)}" }
}

fun canonicalBytes(v: Json): ByteArray = canonicalize(v).toByteArray(Charsets.UTF_8)
```

  (The `1e21`/`1e-7` vectors in Step 1 are only kept if TS output uses exponent form; for values where ES prints exponents, remove the vector and keep the `require` guard — the manifest never emits such values. Document this in the test as `exponentFormRejected`.)
- [ ] **Step 4:** Run the tests → PASS. Add test `negativeZeroAndNonFinite` (`-0.0` → `0`; `NaN` throws).
- [ ] **Step 5:** Commit `feat: RFC 8785 canonical JSON with golden vectors`.

### Task 3: IMU stream codec (WMIMU1) in Kotlin

**Files:**
- Create: `app/src/main/java/com/wrk/app/episode/ImuCodec.kt`, `app/src/test/java/com/wrk/app/episode/ImuCodecTest.kt`, golden file `app/src/test/resources/golden/imu.json`
- Modify: `scripts/gen-golden.mjs` (emit an IMU case: fixed samples → hex bytes via `encodeImuStream` from `/Users/silas/worldmod/web/src/lib/capture/imu-codec.ts`, plus sha256)

**Interfaces:**
- Produces: `data class ImuSample(val t: Float, ax, ay, az, rx, ry, rz: Float)`; `data class ImuStream(val startedAtEpochMs: Double, val samples: List<ImuSample>)`; `fun encodeImuStream(s: ImuStream): ByteArray`; `fun decodeImuStream(b: ByteArray): ImuStream`.

- [ ] **Step 1:** Extend the generator; commit golden hex (3 samples incl. negative values and a value not exactly representable in f32, e.g. `0.1`).
- [ ] **Step 2:** Test: `encode(stream).toHex() == golden.hex`; `decode(encode(x)) == x`; truncated input (length-1) throws `IllegalArgumentException`; bad magic throws; non-finite sample throws. Run → FAIL.
- [ ] **Step 3:** Implement with `ByteBuffer.allocate(20 + 28*n).order(LITTLE_ENDIAN)`: magic `"WMIMU1"` (6 ASCII bytes), version `1`, reserved `0`, `putDouble(startedAtEpochMs)`, `putInt(n)`, then 7 `putFloat` per sample (t, ax, ay, az, rx, ry, rz). Decoder validates length `== 20 + 28n`.
- [ ] **Step 4:** Run tests → PASS. Commit `feat: IMU stream codec compatible with validator`.

### Task 4: Manifest model, hash, seal (golden-compatible)

**Files:**
- Create: `app/src/main/java/com/wrk/app/episode/Manifest.kt`, test `ManifestTest.kt`, golden `manifest.json`
- Modify: `scripts/gen-golden.mjs` (seal a fixed manifest with `sealManifest` from `/Users/silas/worldmod/web/src/lib/manifest/hash.ts`; emit the manifest JSON + `manifest_hash`)

**Interfaces:**
- Consumes: `Json*`, `canonicalBytes` (Task 2).
- Produces: `fun sha256Hex(bytes: ByteArray): String` (`0x`-prefixed lowercase); `fun manifestHash(m: JsonObj): String` (drops `manifest_hash`); `fun seal(m: JsonObj): JsonObj`; `fun verify(m: JsonObj): Boolean`; `const val SCHEMA_VERSION = "0.2.0"`.

Manifest fields follow `/Users/silas/worldmod/web/src/lib/manifest/types.ts` (schema 0.2.0) with Wrk values: `client = {type:"android_native", version, ua_class:"other"}`, plus `chain:"solana"`, `cluster:"devnet"`, `contributor:<base58 pubkey>`; `capture.imu.imu_frame = "device_motion_event"` is replaced by `"android_sensor_event"` and `rotation_convention = "android_gyro_rad_s_xyz"` — **the server's axis mapping (Task 6) must handle these and convert rad/s to deg/s** (see Task 6).

- [ ] **Step 1:** Generator emits golden manifest (include `duration_s: 17.2`, `rate_hz_observed: 98.4`, `fov_deg: null`, nested optional `audio: null`, unicode note). Test: Kotlin `manifestHash(parsed) == golden.manifest_hash`; `seal` is idempotent; `verify` is false after mutating `task`; hash excludes `manifest_hash`. Run → FAIL.
- [ ] **Step 2:** Implement using `MessageDigest.getInstance("SHA-256")`.
- [ ] **Step 3:** Run → PASS. Commit `feat: manifest sealing byte-compatible with validator`.

### Task 5: Server — port validator pipeline, Solana-ready HTTP API

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/index.ts`, `server/src/http.ts`, `server/src/store.ts`, `server/src/bounties.ts`
- Copy then edit (rebrand + de-EVM): from `/Users/silas/worldmod/web/src/lib/{manifest,capture/imu-codec.ts,capture/align.ts,validator,analysis,storage,market}` → `server/src/lib/…` with their `*.test.ts`; copy `trainer`-free only. Replace `@/lib/...` aliases with relative imports via tsconfig `paths`.
- Do **not** copy `lib/chain/*`; payout is Task 11.

**Interfaces:**
- Produces HTTP: `GET /bounties` → `Bounty[]`; `POST /episodes` (multipart: `manifest` JSON, `rgb`, `imu`, optional `audio`, `anchor_signature`) → `202 {episode_id, status:"scoring"}`; idempotent on `episode_id` (second POST returns the stored record, never rescoring/paying); `GET /episodes/:id` → `{status, accepted, plausibility, reasons, payout: null | {signature, amount_usdc}, anchor_signature}`.

- [ ] **Step 1:** `npm init`, install `typescript tsx vitest @tensorflow/tfjs …` matching `/Users/silas/worldmod/web/package.json` versions for the copied modules only; run the **copied** test files (`hash`, `canonicalize`, `imu-codec`, `align`, `score`, `validate`, `correlate`, `flow`) — Expected: PASS before any edits (proves the port is faithful).
- [ ] **Step 2:** Rebrand: grep the copied tree for the old product name and EVM/world-id terms (`rg -i 'worldmod|world mod|ethers|hedera|worldcoin'`) and remove/replace until the grep is empty.
- [ ] **Step 3:** Add `server/src/http.ts` using Node `http` + `busboy`; wire `scoreInBackground` from the old `api/episodes/route.ts` (read it first) to call `scoreEpisode` and `validateEpisode`. Add the `bounty_004` seed from spec §9 plus two siblings in `bounties.ts` (`per_episode_usdc: 0.60`, `min_plausibility: 0.75`, `required_modalities: ["rgb","imu"]`, `motion_policy: "require"`).
- [ ] **Step 4:** Test `http.test.ts`: POST of a fixture episode with tampered `rgb` bytes → record `accepted:false` with a reason mentioning integrity; POST same `episode_id` twice → one stored record. Run → FAIL, implement, → PASS.
- [ ] **Step 5:** Commit `feat: Wrk validator service`.

### Task 6: Server — Android IMU conventions and replay/real fixtures

> **Status note:** Android X/Y/Z gyro axes equal the web beta/gamma/alpha device axes, so the client converts rad/s→deg/s and **no server axis change is needed**. Hand detection is dropped (framing optional). Measured on recorded fixtures: real 71.4/70.2, replay 4.2, so seed bounties use min_plausibility 0.60, not the spec's 0.75.

**Files:**
- Modify: `server/src/lib/validator/score.ts` and/or `analysis/correlate.ts` (axis mapping), `server/src/lib/manifest/types.ts`
- Create: `server/test/fixtures/{real,replay}/…`, `server/src/lib/validator/android-axes.test.ts`

**Interfaces:**
- Consumes: IMU stream where `rx,ry,rz` are Android `Sensor.TYPE_GYROSCOPE` values in **rad/s** about device X/Y/Z, `rotation_convention:"android_gyro_rad_s_xyz"`.
- Produces: scoring treats that convention by converting to deg/s and mapping device axes into camera axes exactly as the existing mapper does for `alpha_z_beta_x_gamma_y_degrees` (read `score.ts`/`correlate.ts` first; Android X=beta-axis, Y=gamma-axis, Z=alpha-axis).

- [ ] **Step 1:** Write a synthetic test: take an existing test video+IMU pair from the old test fixtures, convert the IMU to the Android convention (deg/s→rad/s, same axes), and assert the plausibility score is within 0.01 of the original. Run → FAIL.
- [ ] **Step 2:** Implement the convention switch keyed on `manifest.capture.imu.rotation_convention`; unknown convention → episode fails with a clear reason (not silently scored).
- [ ] **Step 3:** Run → PASS. Add `real` and `replay` fixture folders: copy an existing real capture from `/Users/silas/worldmod` fixtures if present, and build the replay by pairing its video with an IMU trace from a different episode; assert real ≥ 0.75 and replay < 0.75.
- [ ] **Step 4:** Commit `feat: score Android sensor conventions; add real/replay fixtures`.

### Task 7: Bounty feed and Home / Bounty Detail screens

**Files:**
- Create: `data/Bounty.kt`, `data/BountyRepository.kt`, `design/Components.kt`, `ui/HomeScreen.kt`, `ui/BountyDetailScreen.kt`; test `BountyRepositoryTest.kt`
- Modify: `MainActivity.kt` (NavHost with `home`, `bounty/{id}`), `app/build.gradle.kts` (navigation-compose, okhttp, kotlinx-serialization)

**Interfaces:**
- Produces: `data class Bounty(id, title, taskSpec, task, requiredModalities, durationRangeS: IntRange, minPlausibility: Double, perEpisodeUsd: Double, deadline: Long)`; `interface BountyRepository { suspend fun bounties(): List<Bounty> }` with `StaticBountyRepository` (seed) and `ApiBountyRepository(baseUrl)` falling back to static on network error.
- Components: `Panel`, `PaperCard`, `InkCard`, `Chip(selected)`, `KnobBar(label, enabled, onClick)`, `Figure(amount, unit)` (cents at 62% opacity on bone only), `Dock`.

- [ ] **Step 1:** Test: `ApiBountyRepository` returns static seed when the server is unreachable; JSON from server `bounty_004` parses to `perEpisodeUsd == 0.60`.
- [ ] **Step 2:** Implement components per DESIGN.md (Knob Bar: 64dp ink pill, 52dp mint knob; Dock: 30dp ink bar with 68dp disc). Home: earnings figure ("$0.00"), chips for tasks, bounty cards in mint showing `$0.60` per take, no wallet prompt. Detail: instructions, sensors, duration, reward, "Start" KnobBar.
- [ ] **Step 3:** Run on the device (`adb devices` shows `RZ8NC05EB8P`), screenshot with `adb exec-out screencap -p > /tmp/home.png`, and compare against the old contributor screens visually.
- [ ] **Step 4:** Commit `feat: home and bounty detail screens`.

### Task 8: Wallet — Mobile Wallet Adapter connect, token persistence

**Files:**
- Create: `wallet/WalletManager.kt`, `wallet/AuthTokenStore.kt`; test `AuthTokenStoreTest.kt`
- Modify: `app/build.gradle.kts` (MWA clientlib-ktx 2.2.0, web3-solana 0.3.1, rpc-core 0.2.11, `androidx.security:security-crypto:1.1.0-alpha06`), `AndroidManifest.xml` (`<queries>` for `solana-wallet://`), `MainActivity.kt` (create `ActivityResultSender` before `onCreate` returns)

**Interfaces:**
- Produces: `class WalletManager(sender: ActivityResultSender, store: AuthTokenStore)` with `suspend fun connect(): WalletResult` (`Connected(pubkey: String)` | `NoWalletInstalled` | `Declined` | `Failed(msg)`), `suspend fun signAndSend(tx: ByteArray): SendResult` (`Sent(signature: String)` | `Declined` | `Failed`), `val account: StateFlow<String?>`, `suspend fun balanceLamports(): Long`; `AuthTokenStore.save/load/clear` backed by `EncryptedSharedPreferences`.
- Identity: `name="Wrk"`, uri `https://wrk.app` (placeholder URI only; domain unverified), icon `favicon.ico`.

- [ ] **Step 1:** Unit test `AuthTokenStore` round-trip with a fake in-memory backend; clear removes token.
- [ ] **Step 2:** Implement `connect` using `MobileWalletAdapter(providerIdentity).transact(sender) { authorize(...) }`, reuse stored token via `reauthorize` when present, map `TransactionResult.NoWalletFound` → `NoWalletInstalled`, `Failure` with user decline → `Declined`.
- [ ] **Step 3:** Settings/Home shows "Payment account set up" with truncated address as secondary text; "Set up payment account" opens a wallet install link when `NoWalletInstalled`.
- [ ] **Step 4:** Manual verification on the device with a devnet wallet app (Phantom/Solflare set to devnet): connect, kill app, relaunch — no re-approval. Record result in the task notes.
- [ ] **Step 5:** Commit `feat: payment account via Mobile Wallet Adapter`.

### Task 9: Capture — permissions, CameraX, IMU, RawCapture

**Files:**
- Create: `capture/ImuRecorder.kt`, `capture/VideoRecorder.kt`, `capture/CaptureController.kt`, `ui/CaptureScreen.kt`; tests `ImuRecorderTest.kt` (pure-logic parts: rate estimation, monotonic offset)
- Modify: `AndroidManifest.xml` (`CAMERA`, `RECORD_AUDIO`, optional `ACCESS_COARSE_LOCATION`, `<uses-feature android:name="android.hardware.sensor.gyroscope" android:required="true"/>`), `build.gradle.kts` (CameraX camera2/lifecycle/video/view 1.4.x)

**Interfaces:**
- Produces:

```kotlin
data class RawCapture(
    val videoFile: File, val audioPresent: Boolean,
    val imu: ImuStream, val imuRateHz: Double,
    val width: Int, val height: Int, val fpsNominal: Int, val fpsObserved: Double?,
    val startedAtEpochMs: Long, val durationMs: Long, val measuredSkewMs: Double?,
    val screenOrientation: String, val deviceLabel: String?
)
class CaptureController { suspend fun record(maxMs: Long, onTick: (Long) -> Unit): RawCapture; fun cancel() }
```

- `ImuRecorder` registers `TYPE_ACCELEROMETER` and `TYPE_GYROSCOPE` at `SENSOR_DELAY_FASTEST`, stamps each sample with `(event.timestamp - t0Nanos)/1e6` (elapsed-realtime-nanos clock, the same clock as CameraX sensor timestamps); gyro values stay rad/s; emits one merged sample per gyro event using the latest accel.

- [ ] **Step 1:** Unit-test the merging/rate logic: feed synthetic events at 100 Hz for 1 s → 100 samples, `rate ≈ 100 ± 1`, `t` strictly increasing, first `t` ≥ 0.
- [ ] **Step 2:** Implement `ImuRecorder`, `VideoRecorder` (CameraX `Recorder` + `VideoCapture`, `Quality.HD`, 30 fps target, file in `filesDir/episodes/<id>/rgb.mp4`, audio enabled iff permission granted), and `CaptureController` aligning both: IMU `t0` and video start are set from the `VideoRecordEvent.Start` callback; `measuredSkewMs` = difference between that callback time and IMU t0.
- [ ] **Step 3:** Permissions flow in `CaptureScreen`: rationale panel (butter field) before the system prompt; denial → panel with "Open settings". No gyroscope → butter panel "This phone can't record motion", capture disabled.
- [ ] **Step 4:** Capture screen per DESIGN.md: ink 30dp viewfinder, remaining-seconds paper pill top-left, 3-2-1 countdown at 76sp, task name over bottom gradient (the one allowed ink gradient), coaching butter pill, stop knob bar. Lock orientation to portrait during recording (`requestedOrientation`) to avoid mid-take rotation.
- [ ] **Step 5:** On-device check: record 15 s; `adb shell run-as com.wrk.app ls files/episodes/*`; pull the file and `ffprobe` it for duration within ±0.3 s of timer.
- [ ] **Step 6:** Commit `feat: native video and motion capture`.

### Task 10: Episode builder, local store, Review screen

**Files:**
- Create: `episode/EpisodeBuilder.kt`, `episode/EpisodeStore.kt`, `ui/ReviewScreen.kt`; tests `EpisodeBuilderTest.kt`, `EpisodeStoreTest.kt`

**Interfaces:**
- Consumes: `RawCapture` (Task 9), `seal`/`sha256Hex` (Task 4), `encodeImuStream` (Task 3).
- Produces: `suspend fun buildEpisode(capture: RawCapture, bounty: Bounty, contributor: String?, selfReport: SelfReport?, clientVersion: String): BuiltEpisode` where `BuiltEpisode(episodeId, manifest: JsonObj /*sealed*/, rgb: File, imu: File, audio: File?)`; `EpisodeStore.save(BuiltEpisode, status)`, `.list()`, `.updateStatus(id, status)`, statuses `not_submitted|submitted|validating|accepted|paid|rejected`; folder layout `episodes/<id>/{manifest.json,rgb.mp4,imu.bin,state.json}`.

- [ ] **Step 1:** Tests: builder output's `streams.imu.sha256` equals `sha256Hex(file bytes)`; `verify(manifest)` true; unknown `selfReport` → `outcome:"unknown"`; duration outside bounty range → `IllegalArgumentException` with coaching message; store round-trips and survives re-instantiation.
- [ ] **Step 2:** Implement; manifest `contributor` may be null before wallet connect — **the contributor address is required at submission**, so `buildEpisode` is invoked after wallet connect (Review screen's "Submit" triggers connect first, then build). Hash the video with a streaming digest (8 KB buffer), never `readBytes()`.
- [ ] **Step 3:** Review screen: clip preview (`VideoView`), detected duration, sensor completeness (accel/gyro sample counts), "Did you complete the task?" toggle, notes, Submit KnobBar.
- [ ] **Step 4:** Commit `feat: episode builder, store and review screen`.

### Task 11: Upload queue, Solana memo anchoring, validation + payout

**Files:**
- Create app: `wallet/MemoTx.kt`, `upload/ApiClient.kt`, `upload/UploadWorker.kt`, `ui/SubmissionScreen.kt`, `ui/ResultScreen.kt`; tests `MemoTxTest.kt`, `ApiClientTest.kt` (MockWebServer)
- Create server: `server/src/solana/verifyMemo.ts`, `server/src/solana/payout.ts`, `server/src/solana/payout.test.ts`; modify `server/src/http.ts`

**Interfaces:**
- Memo text exactly: `wrk:v1:<bounty_id>:<episode_id>:<manifest_hash>` (≤ 566 bytes; fee payer = contributor wallet via MWA; **server-sponsored fees are a follow-up**, noted in README).
- `buildMemoTransaction(feePayer: String, recentBlockhash: String, memo: String): ByteArray` — legacy transaction, one Memo-program instruction (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`), signer = fee payer.
- Server `verifyMemo(signature, expected: {contributor, text}): Promise<boolean>` using `getTransaction`; `payOut({contributor, amountUsdc, episodeId}): Promise<string /*signature*/>` transfers devnet test-mint tokens (mint + treasury keypair from env `WRK_MINT`, `WRK_TREASURY_KEYPAIR`), creates the contributor ATA if absent, **refuses if `store.payout(episodeId)` already exists**.
- Flow: Review→Submit → connect wallet if needed → fetch blockhash via rpc-core → `signAndSend(memoTx)` → persist `anchor_signature` → enqueue `UploadWorker` (WorkManager, `NetworkType.CONNECTED`, exponential backoff, unique by episode_id) → multipart POST → poll `GET /episodes/:id` until `scored`.
- Server on `scored && accepted`: verify memo (accepted only if memo verifies — otherwise `reasons += "anchor_not_found"` and not paid), then `payOut`, store signature; `rejected`/`failed` never reach `payOut`.

- [ ] **Step 1:** Tests: `MemoTx` bytes parse back to one instruction with the right program id and UTF-8 text; `ApiClient` sends all parts and surfaces 5xx as retryable; server `payout.test.ts` with a mocked connection: accepted+verified memo → one transfer; second call → no second transfer; rejected → zero transfers; memo mismatch → zero transfers.
- [ ] **Step 2:** Implement both sides; keep the old EVM `chain/*` out.
- [ ] **Step 3:** Submission screen: stepper (Uploading → Processing → Checking → Payment), states from `EpisodeStore`; Result: accepted → ink settled-payment card with `$0.60` figure + "View receipt" (explorer link `https://explorer.solana.com/tx/<sig>?cluster=devnet`, addresses in Geist Mono, advanced); rejected → paper card with plain-language reasons from `reasons`.
- [ ] **Step 4:** Airplane-mode test on device: submit offline → episode shows queued (butter "Waiting for connection"); re-enable network → completes without user action.
- [ ] **Step 5:** Commit `feat: anchor, upload, validate and pay out episodes`.

### Task 12: End-to-end demo, signed APK, README

**Files:**
- Create: `README.md`, `DEMO.md`, `server/.env.example`, `app/keystore` instructions (keystore itself never committed)
- Modify: `app/build.gradle.kts` (release `signingConfigs` read from `~/.gradle/gradle.properties`)

- [ ] **Step 1:** Fund devnet treasury + create test mint (`spl-token create-token`, `create-account`, `mint`); put values in `server/.env`.
- [ ] **Step 2:** Run `server` (`npx tsx src/index.ts`), `adb reverse tcp:8850 tcp:8850`, record one real capture on the device → expect `accepted`, a payout signature, visible on devnet explorer.
- [ ] **Step 3:** Seed the replay fixture through `curl` multipart → expect `rejected` with a plausibility reason and no payout.
- [ ] **Step 4:** `./gradlew :app:assembleRelease` with a generated keystore → `apksigner verify --print-certs`. Check `aapt dump badging` shows label `Wrk`.
- [ ] **Step 5:** Naming audit: `rg -i 'worldmod|world mod' --glob '!docs/**' --glob '!product-spec.md' .` must return nothing; check a sample memo and manifest by eye.
- [ ] **Step 6:** Commit `docs: README, demo script, release build`.

---

## Self-review

- **Coverage:** wallet connect (T8), bounty feed (T7), capture (T9), manifest hash (T2–4, 10), upload (T11), Solana submission (T11), validator reuse (T5–6), payout (T11), explorer links (T11), dApp Store APK (T12), design reuse (T1, 7), naming rule (T12 audit). Deferred per spec cut-order: federated demo, utility pool, custom escrow/Anchor programs, buyer dashboard, hand detection, model curve screen, sponsored fees.
- **Known risks:** MWA lib 2.2.0 API names must be checked against the quickstart at implementation time; Kotlin `Double.toString` shortest-repr correctness depends on the runtime, so the manifest builder rounds all decimals to ≤3 places and golden tests guard hashing; gyro axis mapping validated only via the synthetic conversion test until a real on-device capture is scored (Task 12 Step 2).
