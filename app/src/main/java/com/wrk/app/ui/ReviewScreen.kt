package com.wrk.app.ui

import android.widget.VideoView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.wrk.app.PendingCapture
import com.wrk.app.design.Chip
import com.wrk.app.design.FieldCard
import com.wrk.app.design.Figure
import com.wrk.app.design.KnobBar
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkTextField
import com.wrk.app.design.WrkType
import com.wrk.app.episode.EpisodeException
import com.wrk.app.episode.SelfReport
import kotlinx.coroutines.launch
import kotlin.math.sqrt

/** Head rotation speed over the take, deg/s: the same two axes the validator pairs with image motion. */
internal fun motionRms(p: PendingCapture): Double {
    val s = p.raw.imu.samples
    if (s.isEmpty()) return 0.0
    return sqrt(s.sumOf { (it.rx * it.rx + it.ry * it.ry).toDouble() } / s.size)
}

private const val MIN_HEAD_MOTION_DPS = 3.0

@Composable
fun ReviewScreen(
    pending: PendingCapture,
    hasAccount: Boolean,
    onSubmit: suspend (SelfReport) -> Unit,
    onNeedAccount: () -> Unit,
    onDiscard: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val raw = pending.raw
    val scope = rememberCoroutineScope()
    var completed by remember { mutableStateOf<Boolean?>(null) }
    var notes by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val rms = remember(pending) { motionRms(pending) }
    val tooStill = rms < MIN_HEAD_MOTION_DPS

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        Text("Review your take", style = WrkType.title, color = WrkColors.foreground)

        // Keyed by the file: a new recording always gets a new player, never the previous take's.
        androidx.compose.runtime.key(raw.videoFile.absolutePath, raw.videoFile.lastModified()) { AndroidView(
            factory = { ctx ->
                VideoView(ctx).apply {
                    setVideoPath(raw.videoFile.absolutePath)
                    setOnPreparedListener { it.isLooping = true; it.setVolume(0f, 0f); start() }
                }
            },
            modifier = Modifier.fillMaxWidth().height(360.dp).clip(RoundedCornerShape(WrkShape.panel)),
        ) }

        Tag("Check the video: no faces, screens or private papers. If there are, delete this take and record it again.")
        Row(horizontalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
            PaperCard(Modifier.weight(1f)) { Column { Tag("Length"); Text("%.0f s".format(raw.durationMs / 1000.0), style = WrkType.figureInline, color = WrkColors.foreground) } }
            PaperCard(Modifier.weight(1f)) { Column { Tag("Motion recorded"); Text(if (tooStill) "Too still" else "Good", style = WrkType.figureInline, color = WrkColors.foreground) } }
        }

        if (tooStill) {
            FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) {
                Text(
                    "You barely moved your head, so this take can't be checked. Record it again and look around naturally as you work.",
                    style = WrkType.body, color = WrkColors.butterInk,
                )
            }
        }

        PaperCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Tag("Did you finish the task?")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip("Yes, I finished", completed == true) { completed = true }
                    Chip("Not quite", completed == false) { completed = false }
                }
                WrkTextField(notes, { notes = it.take(280) }, "Notes (optional)")
            }
        }

        problem?.let { FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(it, style = WrkType.body, color = WrkColors.butterInk) } }

        Figure(pending.bounty.perEpisodeUsd, WrkType.figureLead, knockDownCents = true, unit = "if accepted")

        KnobBar(
            if (busy) "Submitting…" else if (hasAccount) "Submit take" else "Set up payment to submit",
            enabled = !busy && !tooStill && completed != null,
            onClick = {
                if (!hasAccount) { onNeedAccount(); return@KnobBar }
                scope.launch {
                    busy = true; problem = null
                    try { onSubmit(SelfReport(completed == true, notes.trim())) }
                    catch (e: EpisodeException) { problem = e.message }
                    catch (e: Exception) { problem = "Couldn't prepare this take. Try again." }
                    finally { busy = false }
                }
            },
        )
        PaperButton("Discard and record again", onDiscard, Modifier.fillMaxWidth())
    }
}
