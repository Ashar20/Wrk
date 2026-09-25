package com.wrk.app.capture

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.PointF
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import com.wrk.app.episode.OverlayStats
import java.util.concurrent.Executors
import kotlin.math.min

/** Hands found in one analysed frame, normalised to that frame (upright, [0,1]). */
class HandFrame(val hands: List<List<PointF>>, val width: Int, val height: Int)

/**
 * The live skeleton. Analyses a small copy of the camera feed a few times a second, off the main thread, so the
 * contributor can fix their framing mid-take. It never decides acceptance: that is measured on the server from
 * the recorded video. Frames are dropped, never queued, so the encoder is never starved.
 */
class HandTracker(context: Context) : ImageAnalysis.Analyzer {
    private val main = Handler(Looper.getMainLooper())
    val executor = Executors.newSingleThreadExecutor()
    private val landmarker: HandLandmarker? = try {
        HandLandmarker.createFromOptions(
            context,
            HandLandmarker.HandLandmarkerOptions.builder()
                .setBaseOptions(BaseOptions.builder().setModelAssetPath("hand_landmarker.task").build())
                .setRunningMode(RunningMode.IMAGE)
                .setNumHands(2)
                .build(),
        )
    } catch (e: Exception) {
        null
    }

    val available: Boolean get() = landmarker != null

    /** Delivered on the main thread. */
    var onHands: ((HandFrame) -> Unit)? = null

    /** When enabled, a centre-square RGB crop of [cropSize] is handed over about twice a second (background thread). */
    @Volatile var cropEnabled = false
    @Volatile var cropSize = 160
    @Volatile var onCrop: ((ByteArray) -> Unit)? = null

    private var lastRunAt = 0L
    private var lastCropAt = 0L
    @Volatile private var detections = 0
    @Volatile private var totalMs = 0.0
    @Volatile private var errors = 0
    @Volatile private var lastError: String? = null

    fun stats() = OverlayStats(detections, if (detections == 0) 0.0 else totalMs / detections, errors, lastError)

    override fun analyze(image: ImageProxy) {
        try {
            val now = SystemClock.elapsedRealtime()
            if (now - lastRunAt < MIN_INTERVAL_MS) return
            lastRunAt = now

            val raw = image.toBitmap()
            val rotation = image.imageInfo.rotationDegrees
            val upright = if (rotation == 0) raw
            else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)

            landmarker?.let { lm ->
                val t0 = SystemClock.elapsedRealtimeNanos()
                val result = lm.detect(BitmapImageBuilder(upright).build())
                totalMs += (SystemClock.elapsedRealtimeNanos() - t0) / 1e6
                detections++
                val hands = result.landmarks().map { hand -> hand.map { PointF(it.x(), it.y()) } }
                val frame = HandFrame(hands, upright.width, upright.height)
                main.post { onHands?.invoke(frame) }
            }

            if (cropEnabled && now - lastCropAt >= CROP_INTERVAL_MS) {
                lastCropAt = now
                onCrop?.invoke(rgbCrop(upright, cropSize))
            }
        } catch (e: Exception) {
            errors++
            lastError = e.message ?: e.javaClass.simpleName
        } finally {
            image.close()
        }
    }

    fun close() {
        onHands = null; onCrop = null
        executor.shutdown()
        runCatching { landmarker?.close() }
    }

    companion object {
        private const val MIN_INTERVAL_MS = 120L // ~8 analyses a second
        private const val CROP_INTERVAL_MS = 500L

        /** Centre square, scaled to [size], as packed RGB. */
        fun rgbCrop(b: Bitmap, size: Int): ByteArray {
            val side = min(b.width, b.height)
            val square = Bitmap.createBitmap(b, (b.width - side) / 2, (b.height - side) / 2, side, side)
            val scaled = Bitmap.createScaledBitmap(square, size, size, true)
            val px = IntArray(size * size)
            scaled.getPixels(px, 0, size, 0, 0, size, size)
            val out = ByteArray(size * size * 3)
            for (i in px.indices) {
                out[i * 3] = ((px[i] shr 16) and 0xFF).toByte()
                out[i * 3 + 1] = ((px[i] shr 8) and 0xFF).toByte()
                out[i * 3 + 2] = (px[i] and 0xFF).toByte()
            }
            return out
        }
    }
}
