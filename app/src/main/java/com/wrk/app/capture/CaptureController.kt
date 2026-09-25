package com.wrk.app.capture

import android.content.Context
import android.media.MediaMetadataRetriever
import com.wrk.app.episode.RawCapture
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import java.io.File

class CaptureException(message: String) : Exception(message)

/**
 * Runs one take: starts motion sensing, starts the camera, anchors both to the instant the first
 * frame callback fires, records until stopped or [maxMs], and returns what was actually measured.
 */
class CaptureController(private val context: Context, val video: VideoRecorder, val imu: ImuRecorder) {
    @Volatile private var stopRequested = false
    @Volatile private var cancelled = false

    val motionDps: Float get() = imu.motionDps
    fun latestMotion(): FloatArray = imu.latestMotion()

    fun requestStop() { stopRequested = true }
    fun cancel() { cancelled = true; stopRequested = true }

    suspend fun record(file: File, maxMs: Long, onTick: (elapsedMs: Long) -> Unit): RawCapture {
        stopRequested = false; cancelled = false
        val started = CompletableDeferred<Unit>()
        val finished = CompletableDeferred<Throwable?>()
        imu.start()
        var t0 = 0L
        var startedAtEpoch = 0L
        try {
            video.start(file, onStarted = {
                imu.begin(); t0 = System.nanoTime(); startedAtEpoch = System.currentTimeMillis(); started.complete(Unit)
            }, onFinished = { finished.complete(it) })
            try { withTimeout(8_000) { started.await() } } catch (e: Exception) {
                video.stop(); throw CaptureException("The camera didn't start. Close other camera apps and try again.")
            }
            while (!stopRequested) {
                val elapsed = (System.nanoTime() - t0) / 1_000_000
                onTick(elapsed)
                if (elapsed >= maxMs) break
                delay(100)
            }
            val wallMs = (System.nanoTime() - t0) / 1_000_000
            video.stop()
            val err = withTimeout(10_000) { finished.await() }
            val stream = imu.stop()
            if (cancelled) { file.delete(); throw CaptureException("Recording cancelled.") }
            if (err != null) throw CaptureException("The video couldn't be saved. Check your storage and try again.")
            return describe(file, stream, startedAtEpoch, wallMs)
        } finally {
            if (!finished.isCompleted) video.stop()
            imu.stop() // idempotent: makes sure sensors are released on every exit path
        }
    }

    private fun describe(file: File, stream: com.wrk.app.episode.ImuStream, startedAtEpoch: Long, wallMs: Long): RawCapture {
        val mmr = MediaMetadataRetriever()
        try {
            mmr.setDataSource(file.absolutePath)
            fun key(k: Int) = mmr.extractMetadata(k)
            var w = key(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            var h = key(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val rot = key(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            if (rot == 90 || rot == 270) { val t = w; w = h; h = t }
            val durMs = key(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: wallMs
            val frames = key(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toLongOrNull()
            val fps = if (frames != null && durMs > 0) frames * 1000.0 / durMs else null
            return RawCapture(
                videoFile = file,
                imu = stream,
                width = w, height = h, fpsNominal = 30, fpsObserved = fps, frameCount = frames,
                startedAtEpochMs = startedAtEpoch, durationMs = durMs.takeIf { it > 0 } ?: wallMs,
                screenOrientation = "portrait", deviceLabel = "back",
            )
        } finally {
            mmr.release()
        }
    }
}
