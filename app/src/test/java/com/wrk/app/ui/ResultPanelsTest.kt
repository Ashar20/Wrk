package com.wrk.app.ui

import com.wrk.app.design.WrkColors
import com.wrk.app.episode.EpisodeState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ResultPanelsTest {
    private fun state(framing: Double? = null, plaus: Double? = null, corr: Double? = null, hands: Double? = null) =
        EpisodeState(bountyId = "b", bountyTitle = "t", perEpisodeUsd = 0.6, createdAt = 1, framing = framing, plausibility = plaus, motionCorr = corr, handsVisiblePercent = hands)

    @Test fun meterToneFollowsTheVerdictBands() {
        assertEquals(WrkColors.mintInk, meterTone(0.7))
        assertEquals(WrkColors.mintInk, meterTone(0.95))
        assertEquals(WrkColors.butterInk, meterTone(0.69))
        assertEquals(WrkColors.butterInk, meterTone(0.4))
        assertEquals(WrkColors.negative, meterTone(0.39))
        assertEquals(WrkColors.paperSunk, meterTone(null))
    }

    @Test fun neverSeeingHandsTellsThemToTiltDown() {
        assertTrue(framingHint(state(hands = 0.0)).contains("Tilt the phone down"))
        assertTrue(framingHint(state(hands = 40.0)).startsWith("How much of the take"))
    }

    @Test fun motionHintExplainsWhyThereWasNothingToCheck() {
        assertTrue(motionHint(state(plaus = null)).contains("barely moved your head"))
    }

    @Test fun lowMotionAdvisesWalkingAndLookingAround() {
        assertTrue(motionHint(state(plaus = 0.2, corr = 0.2)).contains("Walking and looking around"))
        assertTrue(motionHint(state(plaus = 0.8, corr = 0.8)).startsWith("Whether what the camera saw"))
    }

    @Test fun tracesParseIntoFourAlignedSeries() {
        val t = parseTraces("""[{"t":0,"flowYaw":0.5,"gyroYaw":-0.5,"flowPitch":0.1,"gyroPitch":0.2},{"t":125,"flowYaw":1,"gyroYaw":0.9,"flowPitch":-0.3,"gyroPitch":-0.2}]""")
        assertEquals(listOf(0.5f, 1f), t.flowYaw); assertEquals(listOf(-0.5f, 0.9f), t.gyroYaw)
        assertEquals(listOf(0.1f, -0.3f), t.flowPitch); assertEquals(listOf(0.2f, -0.2f), t.gyroPitch)
        assertTrue(!t.isEmpty)
    }

    @Test fun anEmptyOrSinglePointTraceDrawsNothing() {
        assertTrue(parseTraces("[]").isEmpty)
        assertTrue(parseTraces("""[{"t":0,"flowYaw":0,"gyroYaw":0,"flowPitch":0,"gyroPitch":0}]""").isEmpty)
    }
}
