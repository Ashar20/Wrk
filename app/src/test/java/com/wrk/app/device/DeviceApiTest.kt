package com.wrk.app.device

import com.wrk.app.roles.ApiException
import com.wrk.app.roles.JsonApi
import com.wrk.app.upload.HttpEpisodeApi
import com.wrk.app.upload.UploadResult
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DeviceApiTest {
    @get:Rule val tmp = TemporaryFolder()
    private fun url(s: MockWebServer) = s.url("/").toString().trimEnd('/')
    private fun api(s: MockWebServer) = DeviceApi(JsonApi(url(s), { null }))

    @Test fun asksForAChallengeWithoutSigningIn() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"challenge":"abc"}"""))
            assertEquals("abc", api(s).challenge())
            val sent = s.takeRequest()
            assertEquals("/device/challenge", sent.path); assertEquals(null, sent.getHeader("Authorization"))
        }
    }

    @Test fun registeringSendsTheChainAndReportsHowTrustworthyThePhoneIs() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"device_id":"d1","trust":"attested","level":"strongbox","boot_verified":true,"app_verified":true}"""))
            val r = api(s).register("abc", listOf("leaf", "inter", "root"))
            assertEquals(DeviceRegistration("d1", true, "strongbox", true, true), r)
            val body = JSONObject(s.takeRequest().body.readUtf8())
            assertEquals("abc", body.getString("challenge")); assertEquals(3, body.getJSONArray("chain").length()); assertEquals("leaf", body.getJSONArray("chain").getString(0))
        }
    }

    @Test fun aPhoneThatIsRegisteredButNotFullyVerifiedIsNotAttested() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"device_id":"d2","trust":"heuristic","level":"tee","boot_verified":false,"app_verified":true}"""))
            assertEquals(false, api(s).register("abc", listOf("x", "y")).attested)
        }
    }

    @Test fun aRefusedRegistrationSurfacesAsAnError() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"This phone couldn't be verified.","failures":["x"]}"""))
            val e = runCatching { api(s).register("abc", listOf("x", "y")) }.exceptionOrNull() as ApiException
            assertEquals(400, e.status); assertEquals("This phone couldn't be verified.", e.message)
        }
    }

    @Test fun theTakeMessageIsExactlyWhatTheValidatorChecks() {
        assertEquals("wrk:take:v1:ep_1:0xabc", takeMessage("ep_1", "0xabc"))
    }

    @Test fun uploadsCarryTheDeviceIdAndSignatureWhenThereIsOne() = runTest {
        MockWebServer().use { s ->
            val dir = tmp.newFolder()
            val rgb = java.io.File(dir, "rgb.mp4").apply { writeBytes(byteArrayOf(1)) }
            val imu = java.io.File(dir, "imu.bin").apply { writeBytes(byteArrayOf(2)) }
            s.enqueue(MockResponse().setResponseCode(202).setBody("""{"status":"scoring"}"""))
            HttpEpisodeApi(url(s)).upload("{}", rgb, imu, null, null, DeviceSignature("dev9", "c2ln"))
            val body = s.takeRequest().body.readUtf8()
            assertTrue(body.contains("name=\"device_id\"") && body.contains("dev9"))
            assertTrue(body.contains("name=\"device_signature\"") && body.contains("c2ln"))
            s.enqueue(MockResponse().setResponseCode(202).setBody("""{"status":"scoring"}"""))
            HttpEpisodeApi(url(s)).upload("{}", rgb, imu, null, null)
            assertTrue(!s.takeRequest().body.readUtf8().contains("device_id"))
        }
    }

    @Test fun aValidatorThatDoesNotKnowThePhoneIsTreatedAsRecoverable() = runTest {
        MockWebServer().use { s ->
            val dir = tmp.newFolder()
            val f = java.io.File(dir, "a").apply { writeBytes(byteArrayOf(1)) }
            s.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"This phone isn't registered. Open Wrk again to verify it."}"""))
            assertEquals(UploadResult.DeviceUnknown, HttpEpisodeApi(url(s)).upload("{}", f, f, null, null, DeviceSignature("gone", "c2ln")))
        }
    }

    @Test fun aLimitReachedIsAFinalRefusalWithTheReasonNotARetryLoop() = runTest {
        MockWebServer().use { s ->
            val f = java.io.File(tmp.newFolder(), "a").apply { writeBytes(byteArrayOf(1)) }
            s.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"You've reached today's limit of 5 takes. Come back tomorrow."}"""))
            val r = HttpEpisodeApi(url(s)).upload("{}", f, f, null, null) as UploadResult.Refused
            assertTrue(r.reasons.single().contains("today's limit"))
        }
    }
}
