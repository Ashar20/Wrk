package com.wrk.app.location

import com.wrk.app.data.Bounty
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CoarseLocationTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun aPreciseSpotIsRoundedToTheCentreOfAboutAKilometreCell() {
        val c = CoarseLocation.of(51.50731, -0.12766, false)
        assertEquals(51.51, c.lat, 1e-9); assertEquals(-0.13, c.lon, 1e-9)
    }

    @Test fun twoSpotsInTheSameCellBecomeTheSamePlace() {
        assertEquals(CoarseLocation.of(51.5012, -0.1204, false), CoarseLocation.of(51.5049, -0.1151, false))
        assertTrue(CoarseLocation.of(51.5012, -0.1204, false) != CoarseLocation.of(51.5249, -0.1204, false))
    }

    @Test fun nothingMorePreciseThanTwoDecimalPlacesEverLeavesThePhone() {
        for ((lat, lon) in listOf(51.123456789 to -0.987654321, -33.8688197 to 151.2092955, 0.004 to 0.006)) {
            val c = CoarseLocation.of(lat, lon, false)
            assertEquals(Math.round(c.lat * 100) / 100.0, c.lat, 1e-9)
            assertEquals(Math.round(c.lon * 100) / 100.0, c.lon, 1e-9)
        }
    }

    @Test fun theMockFlagTravelsWithTheLocation() {
        assertTrue(CoarseLocation.of(1.0, 1.0, true).toJson().getBoolean("mock"))
        assertFalse(CoarseLocation.of(1.0, 1.0, false).toJson().getBoolean("mock"))
        assertEquals(1.1, CoarseLocation.of(1.0, 1.0, false).toJson().getDouble("grid_km"), 0.0)
    }

    private fun capture(): RawCapture {
        val f = tmp.newFile().also { it.writeBytes(ByteArray(2048) { b -> b.toByte() }) }
        val imu = ImuStream(1.757e12, List(1500) { i -> ImuSample(i * 10f, 0f, 9.8f, 0f, 1f, 2f, 3f) })
        return RawCapture(f, imu, 720, 1280, 30, 29.7, 445, 1_757_030_400_000, 15_000, "portrait", "back")
    }
    private val bounty = Bounty("bounty_004", "Cup", "spec", "cup", listOf("rgb", "imu"), 8, 30, 0.6, 4_102_444_800L)

    @Test fun theSealedTakeCarriesTheAreaAndTheSealStillHolds() {
        val e = buildEpisode(capture(), tmp.newFolder(), bounty, "Addr", "asset_1", null, "0.1.0", location = CoarseLocation.of(51.5073, -0.1277, false))
        assertTrue(verify(e.manifest))
        val loc = e.manifest.map["location"] as JsonObj
        assertEquals(51.51, (loc.map["lat"] as com.wrk.app.episode.JsonNum).value, 1e-9)
    }

    @Test fun noLocationMeansNoFieldRatherThanAMadeUpOne() {
        val e = buildEpisode(capture(), tmp.newFolder(), bounty, "Addr", "asset_1", null, "0.1.0")
        assertFalse(e.manifest.map.containsKey("location"))
        assertNull((e.manifest.map["location"]))
    }

    @Test fun thePolicyTellsTheAppWhetherLocationIsNeeded() = runTest {
        MockWebServer().use { s ->
            val api = PolicyApi(JsonApi(s.url("/").toString().trimEnd('/'), { null }))
            s.enqueue(MockResponse().setBody("""{"device_required":true,"location_required":true}"""))
            assertEquals(Policy(true, true), api.get())
            s.enqueue(MockResponse().setBody("""{"device_required":false,"location_required":false}"""))
            assertEquals(Policy(false, false), api.get())
            assertEquals("/policy", s.takeRequest().path)
        }
    }

    @Test fun anUnreachableValidatorLeavesThePolicyUnknownNotRequired() = runTest {
        assertNull(PolicyApi(JsonApi("http://127.0.0.1:1", { null })).get())
    }
}
