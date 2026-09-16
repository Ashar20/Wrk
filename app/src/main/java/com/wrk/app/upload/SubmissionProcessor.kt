package com.wrk.app.upload

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
    private val pause: suspend (Long) -> Unit = { delay(it) },
    private val pollMs: Long = 3_000,
    private val maxPolls: Int = 60,
) {
    suspend fun process(id: String): ProcessOutcome {
        var st = store.state(id) ?: return ProcessOutcome.Finished
        if (st.status == EpisodeStatus.Paid || st.status == EpisodeStatus.Rejected) return ProcessOutcome.Finished

        if (st.status == EpisodeStatus.NotSubmitted) {
            val dir = store.dir(id)
            val manifest = File(dir, "manifest.json").readText()
            val contributor = store.manifest(id)?.map?.get("contributor")?.let { (it as com.wrk.app.episode.JsonStr).value }.orEmpty()
            when (val r = api.upload(manifest, File(dir, "rgb.mp4"), File(dir, "imu.bin"), st.anchorSignature, bearerFor(contributor))) {
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

        repeat(maxPolls) {
            val v = api.fetch(id)
            if (v == null) { store.update(id) { it.copy(waiting = true) }; return ProcessOutcome.TryAgain }
            store.update(id) { it.copy(waiting = false) }
            when {
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
