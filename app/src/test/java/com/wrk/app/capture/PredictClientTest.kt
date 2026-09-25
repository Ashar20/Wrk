package com.wrk.app.capture

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PredictClientTest {
    private fun client(s: MockWebServer) = PredictClient(s.url("/").toString().trimEnd('/'))

    @Test fun reportsTheCropSizeWhenAModelIsAvailable() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"available":true,"size":160,"thumbnailSize":64}"""))
            assertEquals(160, client(s).cropSize())
        }
    }

    @Test fun noModelOrNoServerMeansNoBubbleNotAnError() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"available":false}"""))
            assertNull(client(s).cropSize())
        }
        assertNull(PredictClient("http://127.0.0.1:1").cropSize())
    }

    @Test fun sendsTheCropAndMotionInTheOrderTheModelWasTrainedOn() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody(Buffer().write(ByteArray(64 * 64 * 3) { 7 }))
                .addHeader("x-thumbnail-size", "64").addHeader("x-distance", "1.25").addHeader("x-warming", "false"))
            val r = client(s).predict("ep_abc12345", ByteArray(160 * 160 * 3), floatArrayOf(0f, 9.8f, 0f, 1f, 2f, 3f))!!
            assertEquals(1.25, r.distance, 0.0); assertEquals(false, r.warming); assertEquals(64, r.thumbSize)
            assertEquals(64 * 64 * 3, r.rgb.size)
            val sent = s.takeRequest()
            assertEquals("POST", sent.method)
            assertTrue(sent.path!!.startsWith("/predict?session=ep_abc12345&ax=0.0&ay=9.8&az=0.0&rx=1.0&ry=2.0&rz=3.0"))
            assertEquals(160 * 160 * 3L, sent.bodySize)
        }
    }

    @Test fun warmUpIsReported() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody(Buffer().write(ByteArray(64 * 64 * 3)))
                .addHeader("x-thumbnail-size", "64").addHeader("x-warming", "true"))
            assertEquals(true, client(s).predict("ep_abc12345", ByteArray(1), FloatArray(6))!!.warming)
        }
    }

    @Test fun badResponsesAreDroppedQuietly() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(501))
            assertNull(client(s).predict("ep_abc12345", ByteArray(1), FloatArray(6)))
            s.enqueue(MockResponse().setBody("short").addHeader("x-thumbnail-size", "64"))
            assertNull(client(s).predict("ep_abc12345", ByteArray(1), FloatArray(6)))
        }
    }
}
