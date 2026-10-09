package com.wrk.app.trust

import com.wrk.app.device.DeviceSignature
import com.wrk.app.roles.JsonApi
import com.wrk.app.ui.factorValue
import com.wrk.app.ui.tierLabel
import com.wrk.app.ui.visibleFactors
import com.wrk.app.upload.EpisodeView
import com.wrk.app.upload.HttpEpisodeApi
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class TrustTest {
    @get:Rule val tmp = TemporaryFolder()
    private val report = """{"score":62,"tier":"building","cap":39,"used":2,"live_verified_until":1900000000000,"factors":[
        {"id":"phone","label":"Verified phone","points":20,"max":20},
        {"id":"live","label":"Live check passed","points":0,"max":15,"note":"Take the quick live check"},
        {"id":"record","label":"Accepted takes","points":12,"max":30,"note":"3 points for each, up to 10 takes"},
        {"id":"refused","label":"Refused takes","points":-4,"max":0},
        {"id":"duplicates","label":"Copied takes","points":0,"max":0},
        {"id":"live_fail","label":"Failed live checks","points":0,"max":0}]}"""

    private fun server(s: MockWebServer) = s.url("/").toString().trimEnd('/')

    @Test fun aReportIsReadFromTheValidator() {
        val r = parseTrust(JSONObject(report))
        assertEquals(62, r.score); assertEquals("building", r.tier); assertEquals(39, r.cap); assertEquals(2, r.used)
        assertEquals(1900000000000, r.liveVerifiedUntil)
        assertEquals(6, r.factors.size)
        assertEquals(TrustFactor("record", "Accepted takes", 12, 30, "3 points for each, up to 10 takes"), r.factors[2])
        assertNull(r.factors[0].note)
    }

    @Test fun noLiveCheckOnRecordMeansNoExpiry() {
        val r = parseTrust(JSONObject(report.replace("1900000000000", "null")))
        assertNull(r.liveVerifiedUntil)
    }

    @Test fun tiersHaveNamesAPersonCanRead() {
        assertEquals("New", tierLabel("new")); assertEquals("Building trust", tierLabel("building")); assertEquals("Trusted", tierLabel("trusted"))
        assertEquals("New", tierLabel("anything else"))
    }

    @Test fun eachFactorShowsWhatItEarnedOrWhatIsStillToGet() {
        val f = parseTrust(JSONObject(report)).factors
        assertEquals("+20", factorValue(f[0])); assertEquals("0 / 15", factorValue(f[1])); assertEquals("+12", factorValue(f[2])); assertEquals("−4", factorValue(f[3]))
    }

    @Test fun deductionsAppearOnlyOnceTheyApply() {
        val shown = visibleFactors(parseTrust(JSONObject(report))).map { it.id }
        assertEquals(listOf("phone", "live", "record", "refused"), shown) // copies and failed checks are zero, so hidden
    }

    @Test fun theScoreIsFetchedForAnAddressAndNullWhenUnavailable() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody(report))
            assertEquals(62, TrustApi(JsonApi(server(s), { null })).get("Addr1111")!!.score)
            assertEquals("/trust/Addr1111", s.takeRequest().path)
            s.enqueue(MockResponse().setResponseCode(404))
            assertNull(TrustApi(JsonApi(server(s), { null })).get("nope"))
        }
        assertNull(TrustApi(JsonApi("http://127.0.0.1:1", { null })).get("x"))
    }

    // ---- the standalone live check upload -------------------------------------------------------------------
    private fun files(): Pair<java.io.File, java.io.File> {
        val d = tmp.newFolder(); return java.io.File(d, "a").apply { writeBytes(byteArrayOf(1)) } to java.io.File(d, "b").apply { writeBytes(byteArrayOf(2)) }
    }

    @Test fun aPassedCheckReportsHowManyMovementsMatchedAndTheNewScore() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"passed":true,"matched":3,"total":3,"trust":$report}"""))
            val (a, b) = files()
            val r = HttpEpisodeApi(server(s)).verifyLive("{}", a, b, DeviceSignature("dev1", "c2ln")) as LiveVerify.Done
            assertTrue(r.passed); assertEquals(3, r.matched); assertEquals(62, r.trust!!.score)
            val sent = s.takeRequest()
            assertEquals("/liveness/verify", sent.path)
            val body = sent.body.readUtf8()
            assertTrue(body.contains("name=\"device_id\"") && body.contains("dev1") && body.contains("name=\"device_signature\""))
        }
    }

    @Test fun aFailedCheckIsAnAnswerNotAnError() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"passed":false,"matched":1,"total":3,"trust":$report}"""))
            val (a, b) = files()
            val r = HttpEpisodeApi(server(s)).verifyLive("{}", a, b, null) as LiveVerify.Done
            assertEquals(false, r.passed); assertEquals(1, r.matched)
        }
    }

    @Test fun refusalsExplainThemselvesAndServerTroubleCanBeRetried() = runTest {
        MockWebServer().use { s ->
            val (a, b) = files()
            s.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"The live check needs a verified phone. Open Wrk once to verify this one."}"""))
            assertTrue((HttpEpisodeApi(server(s)).verifyLive("{}", a, b, null) as LiveVerify.Refused).message.contains("verified phone"))
            s.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":"Too many live checks. Try again in an hour."}"""))
            assertTrue(HttpEpisodeApi(server(s)).verifyLive("{}", a, b, null) is LiveVerify.Retry)
            s.enqueue(MockResponse().setResponseCode(500))
            assertTrue(HttpEpisodeApi(server(s)).verifyLive("{}", a, b, null) is LiveVerify.Retry)
        }
        val (a, b) = files()
        assertTrue(HttpEpisodeApi("http://127.0.0.1:1").verifyLive("{}", a, b, null) is LiveVerify.Retry)
    }

    @Test fun theScoreOnATakeIsReadFromTheValidatorsAnswer() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"status":"scored","accepted":true,"reasons":[],"sybil_score":58,"payment":{"signature":"p","amount_usdc":0.6}}"""))
            val v: EpisodeView = HttpEpisodeApi(server(s)).fetch("ep_1")!!
            assertEquals(58, v.sybilScore)
            s.enqueue(MockResponse().setBody("""{"status":"scored","accepted":false,"reasons":[],"sybil_score":null}"""))
            assertNull(HttpEpisodeApi(server(s)).fetch("ep_2")!!.sybilScore)
        }
    }
}
