package com.wrk.app.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Test

class BountyRepositoryTest {
    private val body = """{"bounties":[{"bounty_id":"bounty_004","title":"Cup","task_spec":"Do it","task":"cup",
        "required_modalities":["rgb","imu"],"duration_range_s":[8,30],"per_episode_usdc":0.6,"deadline":1900000000}]}"""

    @Test fun parsesServerFeed() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody(body))
            val list = ApiBountyRepository(s.url("/").toString().trimEnd('/')).bounties()
            assertEquals(1, list.size)
            assertEquals(0.60, list[0].perEpisodeUsd, 0.0)
            assertEquals(8..30, list[0].minDurationS..list[0].maxDurationS)
        }
    }

    @Test fun fallsBackToSeedWhenUnreachable() = runTest {
        val list = ApiBountyRepository("http://127.0.0.1:1").bounties()
        assertEquals("bounty_004", list.first().id)
    }

    @Test fun fallsBackOnServerError() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(500))
            assertEquals(3, ApiBountyRepository(s.url("/").toString().trimEnd('/')).bounties().size)
        }
    }
}
