package com.wrk.app.capture

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.view.Surface
import androidx.camera.core.CameraSelector
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

    suspend fun bind(owner: LifecycleOwner, view: PreviewView) {
        val provider = suspendCoroutine<ProcessCameraProvider> { c ->
            val f = ProcessCameraProvider.getInstance(context)
            f.addListener({ c.resume(f.get()) }, executor)
        }
        val preview = Preview.Builder().setTargetRotation(Surface.ROTATION_0).build().also { it.surfaceProvider = view.surfaceProvider }
        val recorder = Recorder.Builder()
            .setQualitySelector(QualitySelector.fromOrderedList(listOf(Quality.HD, Quality.SD, Quality.LOWEST)))
            .build()
        val capture = VideoCapture.Builder(recorder).setTargetRotation(Surface.ROTATION_0).build()
        provider.unbindAll()
        provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture)
        videoCapture = capture
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
