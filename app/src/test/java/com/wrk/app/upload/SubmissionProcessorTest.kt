package com.wrk.app.upload

import com.wrk.app.episode.EpisodeState
import com.wrk.app.episode.EpisodeStatus
import com.wrk.app.episode.EpisodeStore
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

private class FakeApi : EpisodeApi {
    var uploads = 0
    var lastBearer: String? = "unset"
    var lastAnchor: String? = "unset"
    var uploadResult: UploadResult = UploadResult.Ok(view("scoring"))
    val fetches = ArrayDeque<EpisodeView?>()
    var tracesJson: String? = """[{"t":0,"flowYaw":0.5,"gyroYaw":0.4,"flowPitch":0.1,"gyroPitch":0.2}]"""
    var traceFetches = 0
    var predictionUploads = 0
    var predictionsOk = true
    override suspend fun traces(episodeId: String): String? { traceFetches++; return tracesJson }
    override suspend fun uploadPredictions(episodeId: String, json: String): Boolean { predictionUploads++; return predictionsOk }
    override suspend fun upload(manifestJson: String, rgb: File, imu: File, anchorSignature: String?, bearer: String?): UploadResult {
        uploads++; lastBearer = bearer; lastAnchor = anchorSignature; return uploadResult
    }
    override suspend fun fetch(episodeId: String) = fetches.removeFirstOrNull()
}

private fun view(status: String, accepted: Boolean? = null, reasons: List<String> = emptyList(), pay: String? = null, payErr: String? = null) =
    EpisodeView(status, accepted, reasons, pay, if (pay != null) 0.6 else null, payErr, null)

class SubmissionProcessorTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var store: EpisodeStore
    private val api = FakeApi()
    private fun processor(token: String? = "tok") = SubmissionProcessor(store, api, { token }, pause = {}, maxPolls = 5)

    @Before fun setUp() {
        store = EpisodeStore(tmp.newFolder())
        val d = store.begin("ep1")
        File(d, "manifest.json").writeText("""{"contributor":"Addr","episode_id":"ep1"}""")
        File(d, "rgb.mp4").writeBytes(byteArrayOf(1)); File(d, "imu.bin").writeBytes(byteArrayOf(2))
        store.write("ep1", EpisodeState(bountyId = "b", bountyTitle = "Cup", perEpisodeUsd = 0.6, createdAt = 1, anchorSignature = "sig"))
    }

    @Test fun acceptedAndPaidEndsPaidWithAmountAndReceipt() = runTest {
        api.fetches += listOf(view("scoring"), view("scored", true, pay = null), view("scored", true, pay = "paySig"))
        assertEquals(ProcessOutcome.Finished, processor().process("ep1"))
        val s = store.state("ep1")!!
        assertEquals(EpisodeStatus.Paid, s.status); assertEquals("paySig", s.paymentSignature); assertEquals(0.6, s.paidUsd, 0.0)
        assertEquals("sig", api.lastAnchor); assertEquals("tok", api.lastBearer)
    }

    @Test fun rejectedKeepsReasonsAndNeverShowsMoney() = runTest {
        api.fetches += view("scored", false, listOf("Motion match was too low for this bounty's requirement."))
        processor().process("ep1")
        val s = store.state("ep1")!!
        assertEquals(EpisodeStatus.Rejected, s.status); assertEquals(0.0, s.paidUsd, 0.0); assertNull(s.paymentSignature)
        assertTrue(s.reasons.single().contains("Motion match"))
    }

    @Test fun offlineUploadKeepsTheTakeAndAsksToRetry() = runTest {
        api.uploadResult = UploadResult.Retry("no network")
        assertEquals(ProcessOutcome.TryAgain, processor().process("ep1"))
        val s = store.state("ep1")!!
        assertEquals(EpisodeStatus.NotSubmitted, s.status); assertTrue(s.waiting)
        assertTrue(File(store.dir("ep1"), "rgb.mp4").exists())
    }

    @Test fun retryingAfterAnUploadThatLandedDoesNotRestartFromScratch() = runTest {
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        api.fetches += view("scored", true, pay = "p")
        processor().process("ep1")
        assertEquals(0, api.uploads); assertEquals(EpisodeStatus.Paid, store.state("ep1")!!.status)
    }

    @Test fun finishedEpisodesAreNeverReprocessed() = runTest {
        store.update("ep1") { it.copy(status = EpisodeStatus.Paid) }
        assertEquals(ProcessOutcome.Finished, processor().process("ep1")); assertEquals(0, api.uploads)
    }

    @Test fun refusedUploadIsFinalAndExplained() = runTest {
        api.uploadResult = UploadResult.Refused(listOf("A stream's contents do not match the digest the manifest declares."))
        assertEquals(ProcessOutcome.Finished, processor().process("ep1"))
        assertEquals(EpisodeStatus.Rejected, store.state("ep1")!!.status)
    }

    @Test fun expiredSignInStopsAndTellsTheContributor() = runTest {
        api.uploadResult = UploadResult.SignInExpired
        assertEquals(ProcessOutcome.NeedsContributor, processor().process("ep1"))
        assertTrue(store.state("ep1")!!.error!!.contains("Sign in again"))
        assertEquals(EpisodeStatus.NotSubmitted, store.state("ep1")!!.status)
    }

    @Test fun validatorUnreachableWhilePollingResumesLater() = runTest {
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        api.fetches += null
        assertEquals(ProcessOutcome.TryAgain, processor().process("ep1"))
        assertEquals(EpisodeStatus.Validating, store.state("ep1")!!.status)
    }

    @Test fun serverSideScoringFailureIsNotBlamedOnTheContributorsMoney() = runTest {
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        api.fetches += view("failed")
        processor().process("ep1")
        val s = store.state("ep1")!!
        assertEquals(EpisodeStatus.Rejected, s.status); assertEquals(0.0, s.paidUsd, 0.0)
    }

    @Test fun payoutErrorIsSurfacedNotSwallowed() = runTest {
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        api.fetches += view("scored", true, payErr = "treasury empty")
        assertEquals(ProcessOutcome.Finished, processor().process("ep1"))
        val s = store.state("ep1")!!
        assertEquals(EpisodeStatus.Accepted, s.status); assertEquals("treasury empty", s.error)
    }

    @Test fun stillScoringAfterTheBudgetAsksToComeBack() = runTest {
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        repeat(10) { api.fetches += view("scoring") }
        assertEquals(ProcessOutcome.TryAgain, processor().process("ep1"))
    }

    @Test fun walletUsersSendNoBearer() = runTest {
        api.fetches += view("scored", false, listOf("x"))
        processor(token = null).process("ep1")
        assertNull(api.lastBearer)
    }

    @Test fun measuredMetricsAreKeptForTheResultScreen() = runTest {
        api.fetches += EpisodeView("scored", true, emptyList(), "p", 0.6, null, null,
            framing = 0.8, plausibility = 0.71, handsVisiblePercent = 90.0, motionCorr = 0.71, validatorScore = 0.93,
            duplicateOf = null, manifestIntact = true, streamsIntact = true)
        processor().process("ep1")
        val s = store.state("ep1")!!
        assertEquals(0.8, s.framing!!, 0.0); assertEquals(0.71, s.plausibility!!, 0.0); assertEquals(90.0, s.handsVisiblePercent!!, 0.0)
        assertEquals(0.93, s.validatorScore!!, 0.0); assertEquals(true, s.manifestIntact); assertNull(s.duplicateOf)
    }

    @Test fun tracesAreFetchedOnceAndSavedBesideTheTake() = runTest {
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        api.fetches += view("scored", false, listOf("x"))
        processor().process("ep1")
        assertTrue(File(store.dir("ep1"), "traces.json").readText().contains("flowYaw"))
        assertEquals(1, api.traceFetches)
    }

    @Test fun missingTracesNeverBlockTheVerdict() = runTest {
        api.tracesJson = null
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        api.fetches += view("scored", true, pay = "p")
        assertEquals(ProcessOutcome.Finished, processor().process("ep1"))
        assertEquals(EpisodeStatus.Paid, store.state("ep1")!!.status)
        assertTrue(!File(store.dir("ep1"), "traces.json").exists())
    }

    @Test fun savedPredictionStripIsSentOnceAndRememberedWhenItLands() = runTest {
        File(store.dir("ep1"), "predictions.json").writeText("""{"predictions":[]}""")
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        api.fetches += listOf(null)
        processor().process("ep1")
        assertEquals(1, api.predictionUploads); assertTrue(store.state("ep1")!!.predictionsSent)
        api.fetches += view("scored", false, listOf("x"))
        processor().process("ep1")
        assertEquals(1, api.predictionUploads)
    }

    @Test fun aFailedPredictionUploadIsRetriedNextTimeAndNeverBlocksPayment() = runTest {
        File(store.dir("ep1"), "predictions.json").writeText("{}")
        api.predictionsOk = false
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        api.fetches += view("scored", true, pay = "p")
        processor().process("ep1")
        assertEquals(EpisodeStatus.Paid, store.state("ep1")!!.status)
        assertTrue(!store.state("ep1")!!.predictionsSent)
    }

    @Test fun aTakeHeldForAReviewerIsShownAsSuchAndThenSettles() = runTest {
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        api.fetches += listOf(view("in_review"), view("in_review"), view("scored", true, pay = "p"))
        assertEquals(ProcessOutcome.Finished, processor().process("ep1"))
        assertEquals(EpisodeStatus.Paid, store.state("ep1")!!.status)
    }

    @Test fun stillWaitingOnAReviewerKeepsItInReviewAndComesBackLater() = runTest {
        store.update("ep1") { it.copy(status = EpisodeStatus.Validating) }
        repeat(10) { api.fetches += view("in_review") }
        assertEquals(ProcessOutcome.TryAgain, processor().process("ep1"))
        assertEquals(EpisodeStatus.InReview, store.state("ep1")!!.status)
        assertEquals(0.0, store.state("ep1")!!.paidUsd, 0.0)
    }

    @Test fun aReviewerRejectionEndsRejectedWithTheirReason() = runTest {
        store.update("ep1") { it.copy(status = EpisodeStatus.InReview) }
        api.fetches += view("scored", false, listOf("A reviewer checked this take and didn't find it genuine."))
        processor().process("ep1")
        val s = store.state("ep1")!!
        assertEquals(EpisodeStatus.Rejected, s.status); assertTrue(s.reasons.single().contains("reviewer"))
    }
}
