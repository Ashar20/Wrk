package com.wrk.app.upload

import com.wrk.app.device.DeviceSigner
import com.wrk.app.episode.EpisodeStatus
import com.wrk.app.episode.EpisodeStore
import kotlinx.coroutines.delay
import java.io.File

enum class ProcessOutcome {
    /** Nothing more to do (paid, or refused for good). */
    Finished,
    /** Offline or still being checked: run again later, nothing is lost. */
    TryAgain,
    /** Needs the contributor, e.g. their sign-in expired. */
    NeedsContributor,
}

/**
 * Drives one episode from "recorded" to "paid" or "refused", persisting every step so that a
 * killed app, a dropped connection or a retried upload resumes exactly where it stopped.
 */
class SubmissionProcessor(
    private val store: EpisodeStore,
    private val api: EpisodeApi,
    /** The sign-in token valid for the manifest's contributor, or null (wallet users). */
    private val bearerFor: (contributor: String) -> String?,
    /** Signs each take with this phone's hardware key, when it has one. */
    private val signer: DeviceSigner? = null,
    private val pause: suspend (Long) -> Unit = { delay(it) },
    private val pollMs: Long = 3_000,
    private val maxPolls: Int = 60,
) {
    /** What the validator measured, kept on the phone so the result screen works offline. */
    private suspend fun recordMetrics(id: String, v: EpisodeView) {
        store.update(id) {
            it.copy(
                framing = v.framing, plausibility = v.plausibility, handsVisiblePercent = v.handsVisiblePercent,
                motionCorr = v.motionCorr, validatorScore = v.validatorScore, duplicateOf = v.duplicateOf,
                manifestIntact = v.manifestIntact, streamsIntact = v.streamsIntact, trustLevel = v.trustLevel, sybilScore = v.sybilScore,
                liveMatched = v.liveness?.matched, liveTotal = v.liveness?.total, livePassed = v.liveness?.passed,
            )
        }
        val f = File(store.dir(id), "traces.json")
        if (!f.exists()) api.traces(id)?.let { runCatching { f.writeText(it) } }
    }

    /** The live "model's guess" strip is recorded on the phone; hand it over once, best effort. */
    private suspend fun sendPredictionsOnce(id: String) {
        val st = store.state(id) ?: return
        val f = File(store.dir(id), "predictions.json")
        if (st.predictionsSent || !f.exists()) return
        if (api.uploadPredictions(id, f.readText())) store.update(id) { it.copy(predictionsSent = true) }
    }

    suspend fun process(id: String): ProcessOutcome {
        var st = store.state(id) ?: return ProcessOutcome.Finished
        if (st.status == EpisodeStatus.Paid || st.status == EpisodeStatus.Rejected) return ProcessOutcome.Finished

        if (st.status == EpisodeStatus.NotSubmitted) {
            val dir = store.dir(id)
            val manifest = File(dir, "manifest.json").readText()
            val contributor = store.manifest(id)?.map?.get("contributor")?.let { (it as com.wrk.app.episode.JsonStr).value }.orEmpty()
            val hash = (store.manifest(id)?.map?.get("manifest_hash") as? com.wrk.app.episode.JsonStr)?.value
            val device = if (signer != null && hash != null) signer.sign(id, hash) else null
            when (val r = api.upload(manifest, File(dir, "rgb.mp4"), File(dir, "imu.bin"), st.anchorSignature, bearerFor(contributor), device)) {
                UploadResult.DeviceUnknown -> { signer?.reset(); store.update(id) { it.copy(waiting = true) }; return ProcessOutcome.TryAgain }
                is UploadResult.Ok -> st = store.update(id) { it.copy(status = EpisodeStatus.Validating, waiting = false, error = null) }
                is UploadResult.Retry -> { store.update(id) { it.copy(waiting = true) }; return ProcessOutcome.TryAgain }
                is UploadResult.Refused -> {
                    store.update(id) { it.copy(status = EpisodeStatus.Rejected, waiting = false, reasons = r.reasons) }
                    return ProcessOutcome.Finished
                }
                UploadResult.SignInExpired -> {
                    store.update(id) { it.copy(waiting = false, error = "Your sign-in expired. Sign in again to finish submitting.") }
                    return ProcessOutcome.NeedsContributor
                }
            }
        }

        sendPredictionsOnce(id)

        repeat(maxPolls) {
            val v = api.fetch(id)
            if (v == null) { store.update(id) { it.copy(waiting = true) }; return ProcessOutcome.TryAgain }
            store.update(id) { it.copy(waiting = false) }
            if (v.status == "scored") recordMetrics(id, v)
            when {
                v.status == "in_review" -> store.update(id) { it.copy(status = EpisodeStatus.InReview) }
                v.status == "failed" -> {
                    store.update(id) { it.copy(status = EpisodeStatus.Rejected, reasons = listOf("We couldn't check this take. Please record it again.")) }
                    return ProcessOutcome.Finished
                }
                v.status == "scored" && v.accepted == false -> {
                    store.update(id) { it.copy(status = EpisodeStatus.Rejected, reasons = v.reasons) }
                    return ProcessOutcome.Finished
                }
                v.status == "scored" && v.accepted == true && v.paymentSignature != null -> {
                    store.update(id) {
                        it.copy(status = EpisodeStatus.Paid, paidUsd = v.paidUsd ?: it.perEpisodeUsd, paymentSignature = v.paymentSignature, reasons = emptyList())
                    }
                    return ProcessOutcome.Finished
                }
                v.status == "scored" && v.accepted == true -> {
                    // Accepted; the payout lands moments later. A payout error is shown, not hidden.
                    store.update(id) { it.copy(status = EpisodeStatus.Accepted, error = v.paymentError) }
                    if (v.paymentError != null) return ProcessOutcome.Finished
                }
            }
            pause(pollMs)
        }
        return ProcessOutcome.TryAgain
    }
}
