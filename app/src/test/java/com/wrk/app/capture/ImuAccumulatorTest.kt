package com.wrk.app.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImuAccumulatorTest {
    private val ms = 1_000_000L

    @Test fun gyroIsConvertedFromRadiansToDegreesPerSecond() {
        val a = ImuAccumulator().apply { begin(0) }
        a.onGyro(10 * ms, Math.PI.toFloat(), 0f, (Math.PI / 2).toFloat())
        val s = a.samples().single()
        assertEquals(180f, s.rx, 0.01f); assertEquals(90f, s.rz, 0.01f)
    }

    @Test fun samplesBeforeBeginAreDropped() {
        val a = ImuAccumulator()
        a.onGyro(5 * ms, 1f, 1f, 1f)
        a.begin(100 * ms)
        a.onGyro(50 * ms, 1f, 1f, 1f)  // earlier than t0
        a.onGyro(110 * ms, 1f, 1f, 1f)
        assertEquals(listOf(10f), a.samples().map { it.t })
    }

    @Test fun oneHundredHertzForOneSecondGivesAHundredStrictlyIncreasingSamples() {
        val a = ImuAccumulator().apply { begin(1_000 * ms) }
        for (i in 0 until 100) a.onGyro((1_000 + i * 10) * ms, 0.1f, 0f, 0f)
        val s = a.samples()
        assertEquals(100, s.size)
        assertTrue(s.zipWithNext().all { (x, y) -> y.t > x.t })
        assertEquals(0f, s.first().t, 0f)
    }

    @Test fun latestAccelerationRidesWithEachGyroSample() {
        val a = ImuAccumulator().apply { begin(0) }
        a.onAccel(1f, 2f, 3f); a.onGyro(1 * ms, 0f, 0f, 0f)
        a.onAccel(4f, 5f, 6f); a.onGyro(2 * ms, 0f, 0f, 0f)
        assertEquals(listOf(1f, 4f), a.samples().map { it.ax })
    }

    @Test fun beginClearsAPreviousTake() {
        val a = ImuAccumulator().apply { begin(0) }
        a.onGyro(1 * ms, 1f, 1f, 1f)
        a.begin(0)
        assertEquals(0, a.samples().size)
    }

    @Test fun motionLevelRisesWithRotationAndIsReadableBeforeBegin() {
        val a = ImuAccumulator()
        repeat(200) { a.onGyro(it * ms, 0.5f, 0.5f, 0f) }
        assertTrue(a.motionDps > 20f)
    }
}
