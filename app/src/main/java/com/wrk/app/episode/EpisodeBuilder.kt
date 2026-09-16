package com.wrk.app.episode

import com.wrk.app.data.Bounty
import java.io.File
import java.math.BigDecimal
import java.math.RoundingMode
import java.security.SecureRandom

data class SelfReport(val taskCompleted: Boolean, val notes: String)

/** A problem the contributor can fix by recording again. */
class EpisodeException(message: String) : Exception(message)

data class BuiltEpisode(val episodeId: String, val manifest: JsonObj, val dir: File) {
    val rgb get() = File(dir, "rgb.mp4")
    val imu get() = File(dir, "imu.bin")
    val manifestHash get() = (manifest.map[HASH_FIELD] as JsonStr).value
}

fun newEpisodeId(random: SecureRandom = SecureRandom()): String {
    val b = ByteArray(12).also(random::nextBytes)
    return "ep_" + b.joinToString("") { "%02x".format(it) }
}

private fun round(v: Double, places: Int) = BigDecimal(v).setScale(places, RoundingMode.HALF_UP).toDouble()

/**
 * Seals a capture into a manifest the validator can verify byte-for-byte.
 *
 * The video must already be at `<episodeDir>/rgb.mp4`; the motion stream is written beside it.
 * Everything claimed here is measured; anything the phone could not measure is recorded as null.
 */
fun buildEpisode(
    capture: RawCapture,
    dir: File,
    bounty: Bounty,
    contributor: String,
    assetId: String,
    selfReport: SelfReport?,
    clientVersion: String,
    cluster: String = "devnet",
    episodeId: String = newEpisodeId(),
): BuiltEpisode {
    val seconds = capture.durationMs / 1000.0
    if (seconds < bounty.minDurationS) throw EpisodeException("That take was ${"%.0f".format(seconds)} s. This task needs at least ${bounty.minDurationS} s.")
    if (seconds > bounty.maxDurationS) throw EpisodeException("That take was ${"%.0f".format(seconds)} s. This task allows at most ${bounty.maxDurationS} s.")
    if (capture.imu.samples.size < 10) throw EpisodeException("Motion wasn't recorded. Check that this phone's motion sensors are on and try again.")
    if (!capture.videoFile.exists() || capture.videoFile.length() == 0L) throw EpisodeException("The video wasn't saved. Try recording again.")

    dir.mkdirs()
    val rgb = File(dir, "rgb.mp4")
    if (capture.videoFile.canonicalPath != rgb.canonicalPath) capture.videoFile.copyTo(rgb, overwrite = true)
    val imuFile = File(dir, "imu.bin")
    val imuBytes = encodeImuStream(capture.imu)
    imuFile.writeBytes(imuBytes)

    val m = jsonOf(
        "episode_id" to episodeId.json(),
        "schema_version" to SCHEMA_VERSION.json(),
        "chain" to "solana".json(),
        "cluster" to cluster.json(),
        "asset_id" to assetId.json(),
        "entity_id" to contributor.json(),
        "contributor" to contributor.json(),
        "bounty_id" to bounty.id.json(),
        "task" to bounty.task.json(),
        "duration_s" to round(seconds, 3).json(),
        "recorded_at" to (capture.startedAtEpochMs / 1000).json(),
        "client" to jsonOf("type" to "android_native".json(), "version" to clientVersion.json(), "ua_class" to "other".json()),
        "capture" to jsonOf(
            "video" to jsonOf(
                "codec" to "video/mp4".json(),
                "width" to capture.width.json(),
                "height" to capture.height.json(),
                "fps_nominal" to capture.fpsNominal.json(),
                "fps_observed" to capture.fpsObserved?.let { round(it, 3) }.jsonOrNull(),
                "frame_timing" to "recorder_anchored".json(),
                "device_label" to capture.deviceLabel.jsonOrNull(),
                "fov_deg" to JsonNull,
            ),
            "audio" to JsonNull,
            "imu" to jsonOf(
                "rate_hz_observed" to round(capture.imuRateHz, 3).json(),
                "samples" to capture.imu.samples.size.json(),
                "imu_frame" to "android_sensor_event".json(),
                "rotation_convention" to "device_xyz_deg_s".json(),
                "screen_orientation" to capture.screenOrientation.json(),
            ),
        ),
        "streams" to jsonOf(
            "rgb" to jsonOf("sha256" to sha256Hex(rgb).json(), "bytes" to rgb.length().json(), "content_type" to "video/mp4".json()),
            "imu" to jsonOf("sha256" to sha256Hex(imuBytes).json(), "bytes" to imuBytes.size.json(), "content_type" to "application/octet-stream".json()),
        ),
        "sync" to jsonOf("method" to "recorder_anchored".json(), "measured_skew_ms" to JsonNull),
        "outcome" to (selfReport?.let { if (it.taskCompleted) "success" else "failure" } ?: "unknown").json(),
        "self_report" to (selfReport?.let { jsonOf("task_completed" to it.taskCompleted.json(), "notes" to it.notes.json()) } ?: JsonNull),
    )
    val sealed = seal(m)
    File(dir, "manifest.json").writeText(toJsonText(sealed))
    return BuiltEpisode(episodeId, sealed, dir)
}
