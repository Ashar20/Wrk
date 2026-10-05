package com.wrk.app.upload

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Android's Base64 is a stub in JVM tests, so these exercise the paths that don't decode a payload. */
class AnchorTxTest {
    private fun api(s: MockWebServer) = HttpEpisodeApi(s.url("/").toString().trimEnd('/'))
    private val hash = "0x" + "ab".repeat(32)

    @Test fun anEmptyPaymentSetupMeansNothingToSign() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(501).setBody("""{"error":"On-chain payments are off on this validator."}"""))
            assertEquals(AnchorTxResult.NotNeeded, api(s).anchorTx("bounty_004", "ep_1", hash, "Addr"))
        }
    }

    @Test fun refusalsCarryTheServersReasonToThePerson() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":"Finish uploading your other takes first."}"""))
            val r = api(s).anchorTx("bounty_004", "ep_1", hash, "Addr") as AnchorTxResult.Refused
            assertEquals("Finish uploading your other takes first.", r.message)
            s.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"This task isn't open for takes."}"""))
            assertEquals("This task isn't open for takes.", (api(s).anchorTx("b", "ep_1", hash, "Addr") as AnchorTxResult.Refused).message)
        }
    }

    @Test fun serverTroubleAndOfflineAreRetryable() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(500))
            assertTrue(api(s).anchorTx("b", "ep_1", hash, "Addr") is AnchorTxResult.Retry)
        }
        assertTrue(HttpEpisodeApi("http://127.0.0.1:1").anchorTx("b", "ep_1", hash, "Addr") is AnchorTxResult.Retry)
    }

    @Test fun theRequestNamesTheTakeAndTheContributor() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(501))
            api(s).anchorTx("bounty_004", "ep_1", hash, "Addr")
            val sent = s.takeRequest()
            assertEquals("/anchor/tx", sent.path)
            val b = org.json.JSONObject(sent.body.readUtf8())
            assertEquals("bounty_004", b.getString("bounty_id")); assertEquals("ep_1", b.getString("episode_id"))
            assertEquals(hash, b.getString("manifest_hash")); assertEquals("Addr", b.getString("contributor"))
        }
    }
}
