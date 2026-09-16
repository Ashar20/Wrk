package com.wrk.app.capture

import com.wrk.app.episode.ImuSample
import kotlin.math.abs

/**
 * Merges accelerometer and gyroscope events into one stream, one sample per gyro event, stamped
 * in milliseconds since [begin]. Gyro readings arrive in rad/s about the device X/Y/Z axes and
 * leave in deg/s, which is what the validator's scorer expects. Pure so it can be tested off-device.
 */
class ImuAccumulator {
    private var t0Nanos = -1L
    private var ax = 0f
    private var ay = 0f
    private var az = 0f
    private val out = ArrayList<ImuSample>(4096)

    /** Smoothed head-rotation speed, deg/s, for live coaching. */
    @Volatile var motionDps = 0f
        private set

    @Synchronized fun begin(t0: Long) { t0Nanos = t0; out.clear(); motionDps = 0f }

    @Synchronized fun onAccel(x: Float, y: Float, z: Float) { ax = x; ay = y; az = z }

    @Synchronized fun onGyro(tNanos: Long, x: Float, y: Float, z: Float) {
        val dx = Math.toDegrees(x.toDouble()).toFloat()
        val dy = Math.toDegrees(y.toDouble()).toFloat()
        val dz = Math.toDegrees(z.toDouble()).toFloat()
        // Smoothed always, so coaching works while the countdown is still running.
        motionDps = motionDps * 0.95f + (abs(dx) + abs(dy)) * 0.05f
        if (t0Nanos < 0 || tNanos < t0Nanos) return
        out += ImuSample(((tNanos - t0Nanos) / 1_000_000.0).toFloat(), ax, ay, az, dx, dy, dz)
    }

    @Synchronized fun samples(): List<ImuSample> = ArrayList(out)
}
