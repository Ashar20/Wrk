package com.wrk.app.episode

import com.wrk.app.data.Bounty
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class EpisodeBuilderTest {
    @get:Rule val tmp = TemporaryFolder()

    private val bounty = Bounty("bounty_004", "Cup", "spec", "cup_pick_and_place", listOf("rgb", "imu"), 8, 30, 0.6, 4_102_444_800L)
    private fun capture(seconds: Double = 15.0, samples: Int = 1500, video: ByteArray = ByteArray(2048) { it.toByte() }): RawCapture {
        val f = tmp.newFile().also { it.writeBytes(video) }
        val imu = ImuStream(1.757e12, List(samples) { i -> ImuSample(i * 10f, 0f, 9.8f, 0f, 1f, 2f, 3f) })
        return RawCapture(
            videoFile = f, imu = imu, width = 720, height = 1280, fpsNominal = 30, fpsObserved = 29.7, frameCount = 445,
            startedAtEpochMs = 1_757_030_400_000, durationMs = (seconds * 1000).toLong(), screenOrientation = "portrait", deviceLabel = "back",
        )
    }
    private fun build(c: RawCapture, report: SelfReport? = null) =
        buildEpisode(c, tmp.newFolder(), bounty, "9xQeWvG816bUx9EPfEZEoPqdNaE4gqCNTNqmbFnfZoxM", "asset_1", report, "0.1.0")

    @Test fun manifestIsSealedAndStreamsMatchTheFilesOnDisk() {
        val e = build(capture())
        assertTrue(verify(e.manifest))
        val streams = e.manifest.map["streams"] as JsonObj
        assertEquals(sha256Hex(e.rgb), ((streams.map["rgb"] as JsonObj).map["sha256"] as JsonStr).value)
        assertEquals(sha256Hex(e.imu.readBytes()), ((streams.map["imu"] as JsonObj).map["sha256"] as JsonStr).value)
        assertEquals(e.manifestHash, manifestHash(e.manifest))
    }

    @Test fun savedImuFileDecodesToWhatWasRecorded() {
        val c = capture()
        assertEquals(c.imu, decodeImuStream(build(c).imu.readBytes()))
    }

    @Test fun unreportedOutcomeIsUnknownNotSuccess() {
        val m = build(capture()).manifest.map
        assertEquals(JsonStr("unknown"), m["outcome"])
        assertEquals(JsonNull, m["self_report"])
        assertEquals(JsonStr("failure"), build(capture(), SelfReport(false, "")).manifest.map["outcome"])
    }

    @Test fun usesWrkIdentityOnly() {
        val text = toJsonText(build(capture()).manifest)
        assertTrue(text.contains("\"android_native\""))
        assertFalse(text.lowercase().contains("world"))
    }

    @Test fun tooShortOrTooLongTakesAreRejectedWithCoaching() {
        val short = runCatching { build(capture(seconds = 3.0)) }.exceptionOrNull()
        assertTrue(short is EpisodeException && short.message!!.contains("at least 8"))
        val long = runCatching { build(capture(seconds = 45.0)) }.exceptionOrNull()
        assertTrue(long is EpisodeException && long.message!!.contains("at most 30"))
    }

    @Test fun missingMotionIsRejectedBeforeUpload() {
        val e = runCatching { build(capture(samples = 0)) }.exceptionOrNull()
        assertTrue(e is EpisodeException && e.message!!.contains("Motion"))
    }

    @Test fun emptyVideoIsRejected() {
        assertTrue(runCatching { build(capture(video = ByteArray(0))) }.exceptionOrNull() is EpisodeException)
    }

    @Test fun episodeIdsMatchWhatTheValidatorAccepts() {
        repeat(20) { assertTrue(Regex("^ep_[0-9a-f]{24}$").matches(newEpisodeId())) }
    }

    @Test fun manifestRoundTripsThroughDiskWithTheSameHash() {
        val e = build(capture())
        val back = parseJson(java.io.File(e.dir, "manifest.json").readText()) as JsonObj
        assertTrue(verify(back))
        assertEquals(e.manifestHash, manifestHash(back))
    }
}
