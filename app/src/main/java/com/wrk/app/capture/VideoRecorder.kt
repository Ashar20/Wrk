package com.wrk.app.capture

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.view.Surface
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/** CameraX video, portrait, ~720p at 30 fps with audio when the microphone is allowed. */
class VideoRecorder(private val context: Context) {
    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null
    private val executor = ContextCompat.getMainExecutor(context)

    /**
     * Preview, recording and (optionally) a small analysis stream, all in 16:9 so the viewfinder, the saved video and
     * the hand overlay share one field of view. Phones that can't run all three get preview + recording only; the
     * result says whether analysis is on.
     */
    suspend fun bind(owner: LifecycleOwner, view: PreviewView, analyzer: ImageAnalysis.Analyzer? = null, analysisExecutor: java.util.concurrent.Executor? = null): Boolean {
        val provider = suspendCoroutine<ProcessCameraProvider> { c ->
            val f = ProcessCameraProvider.getInstance(context)
            f.addListener({ c.resume(f.get()) }, executor)
        }
        val wide = ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY).build()
        val preview = Preview.Builder().setResolutionSelector(wide).setTargetRotation(Surface.ROTATION_0).build().also { it.surfaceProvider = view.surfaceProvider }
        val recorder = Recorder.Builder()
            .setQualitySelector(QualitySelector.fromOrderedList(listOf(Quality.HD, Quality.SD, Quality.LOWEST)))
            .build()
        val capture = VideoCapture.Builder(recorder).setTargetRotation(Surface.ROTATION_0).build()
        provider.unbindAll()
        videoCapture = capture
        if (analyzer != null && analysisExecutor != null) {
            val analysis = ImageAnalysis.Builder()
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                        .setResolutionStrategy(ResolutionStrategy(Size(640, 360), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                        .build(),
                )
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                .setTargetRotation(Surface.ROTATION_0)
                .build().also { it.setAnalyzer(analysisExecutor, analyzer) }
            try {
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture, analysis)
                return true
            } catch (e: IllegalArgumentException) {
                provider.unbindAll() // this phone can't run all three streams at once
            }
        }
        provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture)
        return false
    }

    /** [onStarted] fires when frames start flowing; [onFinished] when the file is complete or failed. */
    fun start(file: File, onStarted: () -> Unit, onFinished: (Throwable?) -> Unit) {
        val vc = checkNotNull(videoCapture) { "Camera isn't ready." }
        val prepared = vc.output.prepareRecording(context, FileOutputOptions.Builder(file).build())
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            prepared.withAudioEnabled()
        }
        recording = prepared.start(executor) { e ->
            when (e) {
                is VideoRecordEvent.Start -> onStarted()
                is VideoRecordEvent.Finalize ->
                    onFinished(if (e.hasError()) IllegalStateException("Recording failed (code ${e.error}).") else null)
                else -> Unit
            }
        }
    }

    fun stop() { recording?.stop(); recording = null }

    fun release() {
        stop()
        runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
        videoCapture = null
    }
}
