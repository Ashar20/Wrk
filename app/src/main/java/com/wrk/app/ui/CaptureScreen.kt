package com.wrk.app.ui

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.wrk.app.PendingCapture
import com.wrk.app.WrkContainer
import com.wrk.app.capture.CaptureController
import com.wrk.app.capture.CaptureException
import com.wrk.app.capture.ImuRecorder
import com.wrk.app.capture.VideoRecorder
import com.wrk.app.data.Bounty
import com.wrk.app.design.FieldCard
import com.wrk.app.design.InkButton
import com.wrk.app.design.KnobBar
import com.wrk.app.design.PaperButton
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkType
import com.wrk.app.episode.newEpisodeId
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

private sealed interface Phase {
    data object Ready : Phase
    data class Countdown(val n: Int) : Phase
    data class Recording(val elapsedMs: Long) : Phase
    data object Saving : Phase
}

@Composable
fun CaptureScreen(bounty: Bounty, container: WrkContainer, onCaptured: (PendingCapture) -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    val activity = context as Activity
    val scope = rememberCoroutineScope()

    fun granted(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED
    var cameraOk by remember { mutableStateOf(granted(Manifest.permission.CAMERA)) }
    var asked by remember { mutableStateOf(false) }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r ->
        cameraOk = r[Manifest.permission.CAMERA] == true || granted(Manifest.permission.CAMERA)
        asked = true
    }

    // The scorer pairs image motion with head rotation, which only works in a fixed orientation.
    DisposableEffect(Unit) {
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        onDispose { activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
    }

    Column(Modifier.fillMaxSize().padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        Row(horizontalArrangement = Arrangement.spacedBy(WrkShape.stack), verticalAlignment = Alignment.CenterVertically) {
            PaperButton("Back", onBack)
            Text(bounty.title, style = WrkType.title.copy(fontSize = 16.sp), color = WrkColors.foreground, maxLines = 1)
        }

        when {
            !ImuRecorder.hasGyroscope(context) -> BlockedPanel(
                "This phone can't record motion",
                "Wrk checks your video against your head movement, and this phone has no motion sensor to do that. You can still browse tasks.",
            )
            !cameraOk -> BlockedPanel(
                "Allow the camera to record",
                if (asked) "Camera access is off. Turn it on in settings to record." else "Wrk records short clips of what you're doing, with your phone's motion, to check them. Nothing is shared until you submit.",
            ) {
                if (!asked) InkButton("Allow camera and microphone", { request.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)) }, Modifier.fillMaxWidth())
                else {
                    InkButton("Try again", { request.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)) }, Modifier.fillMaxWidth())
                    PaperButton("Open settings", {
                        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
                    }, Modifier.fillMaxWidth())
                }
            }
            else -> Viewfinder(bounty, container, scope, onCaptured)
        }
    }
}

@Composable
private fun BlockedPanel(title: String, body: String, actions: @Composable () -> Unit = {}) {
    FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = WrkType.title, color = WrkColors.butterInk)
            Text(body, style = WrkType.body, color = WrkColors.butterInk)
            actions()
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.ColumnScope.Viewfinder(
    bounty: Bounty,
    container: WrkContainer,
    scope: kotlinx.coroutines.CoroutineScope,
    onCaptured: (PendingCapture) -> Unit,
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val view = remember { PreviewView(context).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE; keepScreenOn = true; scaleType = PreviewView.ScaleType.FILL_CENTER } }
    val video = remember { VideoRecorder(context) }
    val controller = remember { CaptureController(context, video, ImuRecorder(context)) }
    var phase by remember { mutableStateOf<Phase>(Phase.Ready) }
    var problem by remember { mutableStateOf<String?>(null) }
    var cameraReady by remember { mutableStateOf(false) }
    var coaching by remember { mutableStateOf<String?>(null) }
    var elapsedMs by remember { mutableLongStateOf(0L) }

    LaunchedEffect(Unit) {
        try { video.bind(owner, view); cameraReady = true } catch (e: Exception) { problem = "The camera isn't available. Close other camera apps and try again." }
    }
    DisposableEffect(Unit) { onDispose { controller.cancel(); video.release() } }

    val minMs = bounty.minDurationS * 1000L
    val maxMs = bounty.maxDurationS * 1000L

    Box(
        Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(WrkShape.panel)).background(WrkColors.ink),
    ) {
        AndroidView({ view }, Modifier.fillMaxSize())
        val p = phase
        if (p is Phase.Recording || p is Phase.Saving) {
            val left = ((maxMs - elapsedMs).coerceAtLeast(0) / 1000.0)
            Box(Modifier.align(Alignment.TopStart).padding(16.dp).clip(RoundedCornerShape(50)).background(WrkColors.paper).padding(horizontal = 14.dp, vertical = 8.dp)) {
                Text("%.0f s left".format(left), style = WrkType.figureInline, color = WrkColors.foreground)
            }
            Box(Modifier.align(Alignment.TopEnd).padding(20.dp).clip(RoundedCornerShape(50)).background(WrkColors.negative).padding(6.dp))
        }
        if (p is Phase.Countdown) {
            Text("${p.n}", style = WrkType.figureHero.copy(fontSize = 76.sp), color = WrkColors.onInk, modifier = Modifier.align(Alignment.Center))
        }
        coaching?.let {
            Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 72.dp).clip(RoundedCornerShape(50)).background(WrkColors.butter).padding(horizontal = 16.dp, vertical = 10.dp)) {
                Text(it, style = WrkType.body, color = WrkColors.butterInk)
            }
        }
        Box(
            Modifier.align(Alignment.BottomStart).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, WrkColors.ink.copy(alpha = 0.85f)))).padding(16.dp),
        ) { Text(bounty.title, style = WrkType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = WrkColors.onInk) }
    }

    problem?.let { FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(it, style = WrkType.body, color = WrkColors.butterInk) } }

    val p = phase
    val canStop = p is Phase.Recording && elapsedMs >= minMs
    val label = when (p) {
        Phase.Ready -> "Start recording"
        is Phase.Countdown -> "Get ready…"
        is Phase.Recording -> if (canStop) "Stop and review" else "Keep going (${((minMs - elapsedMs) / 1000 + 1)} s)"
        Phase.Saving -> "Saving…"
    }
    KnobBar(
        label,
        enabled = cameraReady && (p == Phase.Ready || canStop),
        onClick = {
            if (p == Phase.Ready) {
                problem = null; coaching = null
                scope.launch {
                    val id = newEpisodeId()
                    val file = File(container.episodes.begin(id), "rgb.mp4")
                    for (n in 3 downTo 1) { phase = Phase.Countdown(n); delay(1000) }
                    elapsedMs = 0
                    phase = Phase.Recording(0)
                    try {
                        val raw = controller.record(file, maxMs) { ms ->
                            elapsedMs = ms
                            phase = Phase.Recording(ms)
                            coaching = if (ms in 2_000..(maxMs - 2_000) && controller.motionDps < 3f) "Turn your head a little as you work" else null
                        }
                        phase = Phase.Saving
                        onCaptured(PendingCapture(id, raw, bounty))
                    } catch (e: CaptureException) {
                        problem = e.message; phase = Phase.Ready; container.episodes.delete(id)
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        container.episodes.delete(id); throw e
                    } catch (e: Exception) {
                        android.util.Log.e("WrkCapture", "recording failed", e)
                        problem = "Something went wrong while recording. Try again."; phase = Phase.Ready; container.episodes.delete(id)
                    }
                }
            } else controller.requestStop()
        },
    )
}
