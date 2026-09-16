package com.wrk.app.episode

import java.io.File

/** What the recorders hand over: a video file on disk plus the motion stream, nothing derived. */
data class RawCapture(
    val videoFile: File,
    val imu: ImuStream,
    val width: Int,
    val height: Int,
    val fpsNominal: Int,
    /** Null when the platform could not report it; never guessed. */
    val fpsObserved: Double?,
    val startedAtEpochMs: Long,
    val durationMs: Long,
    val screenOrientation: String,
    val deviceLabel: String?,
) {
    /** Mean gyro-sample rate over the recording. */
    val imuRateHz: Double
        get() = if (imu.samples.size < 2) 0.0
        else (imu.samples.size - 1) * 1000.0 / (imu.samples.last().t - imu.samples.first().t).coerceAtLeast(1f)
}
