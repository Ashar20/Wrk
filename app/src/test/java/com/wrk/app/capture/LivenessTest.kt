package com.wrk.app.capture

import com.wrk.app.data.Bounty
import com.wrk.app.episode.EpisodeStatus
import com.wrk.app.episode.ImuSample
import com.wrk.app.episode.ImuStream
import com.wrk.app.episode.JsonObj
import com.wrk.app.episode.RawCapture
import com.wrk.app.episode.buildEpisode
import com.wrk.app.episode.verify
import com.wrk.app.roles.JsonApi
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class LivenessTest {
    @get:Rule val tmp = TemporaryFolder()
    private val prompts = listOf(Prompt(2200, Axis.Yaw), Prompt(6400, Axis.Pitch), Prompt(10700, Axis.Yaw), Prompt(14900, Axis.Pitch))

    // ---- what's on screen -------------------------------------------------------------------------------------
    @Test fun aPromptIsOnScreenForItsFullTimeAndThenGone() {
        assertNull(LivenessSchedule.current(prompts, 2199))
        assertEquals(prompts[0], LivenessSchedule.current(prompts, 2200))
        assertEquals(prompts[0], LivenessSchedule.current(prompts, 5199))
        assertNull(LivenessSchedule.current(prompts, 5200)) // 3 s later
        assertEquals(prompts[1], LivenessSchedule.current(prompts, 6400))
    }

    @Test fun promptsAreCountedAsTheyAppear() {
        assertEquals(0, LivenessSchedule.shownCount(prompts, 1000))
        assertEquals(1, LivenessSchedule.shownCount(prompts, 2200))
        assertEquals(2, LivenessSchedule.shownCount(prompts, 8000))
        assertEquals(4, LivenessSchedule.shownCount(prompts, 30_000))
    }

    // ---- when a take may end ----------------------------------------------------------------------------------
    @Test fun aTakeCannotEndBeforeTwoPromptsHaveBeenAnsweredInFull() {
        val min = 8_000L
        assertFalse(LivenessSchedule.canStop(prompts, 3_000, min))   // one prompt, mid-way
        assertFalse(LivenessSchedule.canStop(prompts, 8_000, min))   // old enough, but the second prompt (6.4 s) needs until 9.4 s
        assertFalse(LivenessSchedule.canStop(prompts, 9_399, min))
        assertTrue(LivenessSchedule.canStop(prompts, 9_400, min))
    }

    @Test fun aLaterPromptThatHasAppearedMustBeFinishedToo() {
        assertTrue(LivenessSchedule.canStop(prompts, 10_000, 8_000))  // between prompts: free to stop
        assertFalse(LivenessSchedule.canStop(prompts, 10_700, 8_000)) // third has just appeared
        assertFalse(LivenessSchedule.canStop(prompts, 13_699, 8_000))
        assertTrue(LivenessSchedule.canStop(prompts, 13_700, 8_000))
    }

    @Test fun theTasksMinimumLengthStillApplies() {
        assertFalse(LivenessSchedule.canStop(prompts, 9_500, 12_000))  // prompts are done, but the task wants 12 s
        assertFalse(LivenessSchedule.canStop(prompts, 12_000, 12_000)) // and by then a third has appeared
        assertTrue(LivenessSchedule.canStop(prompts, 13_700, 12_000))
    }

    // ---- what is reported -------------------------------------------------------------------------------------
    @Test fun onlyPromptsThatHadTheirFullTimeAreClaimed() {
        assertEquals(prompts.take(2), LivenessSchedule.claimed(prompts, 9_400))
        assertEquals(prompts.take(1), LivenessSchedule.claimed(prompts, 9_399))
        assertEquals(prompts.take(3), LivenessSchedule.claimed(prompts, 15_000))
        assertEquals(prompts, LivenessSchedule.claimed(prompts, 20_000))
        assertEquals(emptyList<Prompt>(), LivenessSchedule.claimed(prompts, 4_000))
    }

    @Test fun theClaimMatchesWhatTheValidatorExpects() {
        val j = LivenessClaim("abc123", prompts.take(2)).toJson()
        assertEquals("abc123", j.getString("nonce"))
        val a = j.getJSONArray("prompts")
        assertEquals(2, a.length())
        assertEquals(2200L, a.getJSONObject(0).getLong("at_ms")); assertEquals("yaw", a.getJSONObject(0).getString("axis"))
        assertEquals("pitch", a.getJSONObject(1).getString("axis"))
    }

    @Test fun promptsExplainThemselvesInPlainWords() {
        assertTrue(Prompt(0, Axis.Yaw).text.contains("left, then right"))
        assertTrue(Prompt(0, Axis.Pitch).text.contains("up, then down"))
    }

    // ---- the validator's sequence -----------------------------------------------------------------------------
    @Test fun aChallengeIsReadFromTheValidator() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"nonce":"n1","prompts":[{"at_ms":2000,"axis":"pitch"},{"at_ms":6100,"axis":"yaw"}]}"""))
            val c = LivenessApi(JsonApi(s.url("/").toString().trimEnd('/'), { null })).challenge()
            assertEquals(LivenessChallenge("n1", listOf(Prompt(2000, Axis.Pitch), Prompt(6100, Axis.Yaw))), c)
            assertEquals("/liveness/challenge", s.takeRequest().path)
        }
    }

    // ---- the sealed take --------------------------------------------------------------------------------------
    private fun capture(): RawCapture {
        val f = tmp.newFile().also { it.writeBytes(ByteArray(2048) { b -> b.toByte() }) }
        val imu = ImuStream(1.757e12, List(1500) { i -> ImuSample(i * 10f, 0f, 9.8f, 0f, 1f, 2f, 3f) })
        return RawCapture(f, imu, 720, 1280, 30, 29.7, 445, 1_757_030_400_000, 15_000, "portrait", "back")
    }
    private val bounty = Bounty("bounty_008", "Cup", "spec", "cup", listOf("rgb", "imu"), 8, 30, 1.2, 4_102_444_800L, liveCheck = true)

    @Test fun theSealedManifestCarriesTheClaimAndStillVerifies() {
        val claim = LivenessClaim("abc123", prompts.take(3))
        val e = buildEpisode(capture(), tmp.newFolder(), bounty, "Addr", "asset_1", null, "0.1.0", liveness = claim)
        assertTrue(verify(e.manifest))
        val live = e.manifest.map["liveness"] as JsonObj
        assertEquals("abc123", (live.map["nonce"] as com.wrk.app.episode.JsonStr).value)
        assertEquals(3, (live.map["prompts"] as com.wrk.app.episode.JsonArr).items.size)
    }

    @Test fun tasksWithoutALiveCheckLeaveItOutAndTamperingBreaksTheSeal() {
        val plain = buildEpisode(capture(), tmp.newFolder(), bounty, "Addr", "asset_1", null, "0.1.0")
        assertFalse(plain.manifest.map.containsKey("liveness"))
        val e = buildEpisode(capture(), tmp.newFolder(), bounty, "Addr", "asset_1", null, "0.1.0", liveness = LivenessClaim("n", prompts.take(2)))
        val forged = JsonObj(e.manifest.map + ("liveness" to com.wrk.app.episode.parseJson("""{"nonce":"other","prompts":[]}""")))
        assertFalse(verify(forged)) // the claim can't be swapped after sealing
    }

    @Test fun theBountyFlagIsReadFromTheFeed() {
        val o = JSONObject("""{"bounty_id":"b","title":"t","task_spec":"s","task":"x","required_modalities":["rgb"],"duration_range_s":[8,30],"per_episode_usdc":1,"deadline":1,"liveness":"require"}""")
        assertTrue(com.wrk.app.data.Bounty.fromJson(o).liveCheck)
        o.put("liveness", "off"); assertFalse(com.wrk.app.data.Bounty.fromJson(o).liveCheck)
        o.remove("liveness"); assertFalse(com.wrk.app.data.Bounty.fromJson(o).liveCheck)
    }
}
