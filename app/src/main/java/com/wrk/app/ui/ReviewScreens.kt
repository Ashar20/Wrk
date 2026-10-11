package com.wrk.app.ui

import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.wrk.app.design.FieldCard
import com.wrk.app.design.Figure
import com.wrk.app.design.InkButton
import com.wrk.app.design.InkCard
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkTextField
import com.wrk.app.design.WrkType
import com.wrk.app.roles.ApiException
import com.wrk.app.roles.ReviewApi
import com.wrk.app.roles.ReviewItem
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale

private sealed interface Queue {
    data object Loading : Queue
    data class Loaded(val items: List<ReviewItem>) : Queue
    data class Failed(val message: String) : Queue
}

/** Takes the automatic checks couldn't call, oldest first. Refreshes itself. */
@Composable
fun ReviewQueueScreen(api: ReviewApi, onOpen: (ReviewItem) -> Unit, modifier: Modifier = Modifier) {
    val queue by produceState<Queue>(Queue.Loading) {
        while (true) {
            value = try { Queue.Loaded(api.queue()) } catch (e: ApiException) { Queue.Failed(e.message ?: "Couldn't load the queue.") }
            delay(5_000)
        }
    }
    LazyColumn(modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        item {
            Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Review queue", style = WrkType.title, color = WrkColors.foreground)
                Text("Watch each take and decide whether a person wearing the phone really did the task. You're paid for every decision, approve or reject.", style = WrkType.body, color = WrkColors.muted)
            }
        }
        when (val q = queue) {
            Queue.Loading -> item { Text("Loading…", style = WrkType.body, color = WrkColors.muted) }
            is Queue.Failed -> item { FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(q.message, style = WrkType.body, color = WrkColors.butterInk) } }
            is Queue.Loaded -> {
                if (q.items.isEmpty()) item {
                    FieldCard(WrkColors.paperSunk, Modifier.fillMaxWidth()) { Text("Nothing to review right now. New takes show up here on their own.", style = WrkType.body, color = WrkColors.muted) }
                }
                items(q.items, key = { it.episodeId }) { ReviewCard(it) { onOpen(it) } }
            }
        }
    }
}

@Composable
private fun ReviewCard(i: ReviewItem, onClick: () -> Unit) {
    PaperCard(Modifier.fillMaxWidth(), onClick = onClick) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(i.bountyTitle, style = WrkType.title, color = WrkColors.foreground)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FieldCard(WrkColors.lilac) { Text(i.plausibility?.let { "${Math.round(it * 100)}% motion" } ?: "motion —", style = WrkType.figureInline, color = WrkColors.lilacInk) }
                FieldCard(WrkColors.paperSunk) { Text(String.format(Locale.US, "%.0f s", i.durationS), style = WrkType.figureInline, color = WrkColors.foreground) }
                FieldCard(WrkColors.mint) { Figure(i.feeUsd, WrkType.figureInline, WrkColors.mintInk, unit = "to you") }
            }
        }
    }
}

/** The video, the numbers behind it, and a decision. The first decision on a take wins. */
@Composable
fun ReviewDetailScreen(item: ReviewItem, api: ReviewApi, onDone: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var earned by remember { mutableStateOf<Double?>(null) }
    var verdict by remember { mutableStateOf<Boolean?>(null) }
    val traces by produceState<TracePoints?>(null, item.episodeId) {
        value = api.traces(item.episodeId)?.let { runCatching { parseTraces(it) }.getOrNull() }
    }

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        PaperButton("Back", onBack)
        Text(item.bountyTitle, style = WrkType.title, color = WrkColors.foreground)
        Text(item.taskSpec, style = WrkType.body, color = WrkColors.muted)
        Tag(if (item.trustLevel == "attested") "Signed by a verified phone" else "Phone not verified")

        androidx.compose.runtime.key(item.episodeId) { AndroidView(
            factory = { ctx ->
                VideoView(ctx).apply {
                    setVideoURI(Uri.parse(api.videoUrl(item.episodeId)), api.authHeader())
                    setMediaController(MediaController(ctx).also { it.setAnchorView(this) })
                    setOnPreparedListener { it.isLooping = true; start() }
                }
            },
            modifier = Modifier.fillMaxWidth().height(380.dp).clip(RoundedCornerShape(WrkShape.panel)),
        ) }

        PaperCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Meter("Hands in view", item.framing, framingHint(item.handsVisiblePercent))
                Meter("Motion check", item.plausibility, motionHint(item.plausibility, item.motionCorr))
            }
        }
        traces?.takeIf { !it.isEmpty }?.let { TracesBlock(it) }

        val done = verdict
        if (done == null) {
            FieldCard(WrkColors.lilac, Modifier.fillMaxWidth()) {
                Text(
                    "The automatic checks were close to the bar. Approve if this looks like a real person doing the task with the phone on their head; reject if it looks replayed, staged or off-task.",
                    style = WrkType.body, color = WrkColors.lilacInk,
                )
            }
            WrkTextField(note, { note = it.take(280) }, "Note (optional)")
            problem?.let { FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(it, style = WrkType.body, color = WrkColors.butterInk) } }
            fun decide(approve: Boolean) = scope.launch {
                busy = true; problem = null
                try { earned = api.decide(item.episodeId, approve, note.trim()); verdict = approve }
                catch (e: ApiException) { problem = e.message }
                finally { busy = false }
            }
            InkButton(if (busy) "Saving…" else "Approve · pay the contributor", { if (!busy) decide(true) }, Modifier.fillMaxWidth(), enabled = !busy)
            PaperButton("Reject", { if (!busy) decide(false) }, Modifier.fillMaxWidth())
            if (problem != null) PaperButton("Back to the queue", onDone, Modifier.fillMaxWidth())
        } else {
            InkCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(if (done) "Approved" else "Rejected", style = WrkType.label, color = WrkColors.onInkMuted)
                    if ((earned ?: 0.0) > 0) Figure(earned ?: 0.0, WrkType.figureHero, WrkColors.onInk)
                    Text(if ((earned ?: 0.0) > 0) "Paid to your payment account for this review." else "Thanks. Your review fee will show in History once it's sent.", style = WrkType.body, color = WrkColors.onInkMuted)
                }
            }
            InkButton("Next take", onDone, Modifier.fillMaxWidth())
        }
    }
}

@Composable
fun ReviewHistoryScreen(api: ReviewApi, modifier: Modifier = Modifier) {
    val h by produceState<Result<com.wrk.app.roles.ReviewHistory>?>(null) {
        while (true) { value = runCatching { api.history() }; delay(8_000) }
    }
    LazyColumn(modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        item {
            Column(Modifier.padding(top = 12.dp)) {
                Text("History", style = WrkType.title, color = WrkColors.foreground)
                Tag("Earned from reviews", modifier = Modifier.padding(top = 20.dp))
                Figure(h?.getOrNull()?.earnedUsd ?: 0.0, WrkType.figureLead, knockDownCents = true)
            }
        }
        val r = h
        if (r?.isFailure == true) item { FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text((r.exceptionOrNull() as? ApiException)?.message ?: "Couldn't load your history.", style = WrkType.body, color = WrkColors.butterInk) } }
        val items = r?.getOrNull()?.items.orEmpty()
        if (r?.isSuccess == true && items.isEmpty()) item { FieldCard(WrkColors.paperSunk, Modifier.fillMaxWidth()) { Text("Your decisions will show up here.", style = WrkType.body, color = WrkColors.muted) } }
        items(items, key = { it.episodeId }) { i ->
            val uri = androidx.compose.ui.platform.LocalUriHandler.current
            PaperCard(Modifier.fillMaxWidth(), onClick = i.feeSignature?.let { sig -> { uri.openUri(txUrl(sig)) } }) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Text(i.bountyTitle, style = WrkType.body.copy(fontWeight = FontWeight.SemiBold), color = WrkColors.foreground, maxLines = 1)
                        Tag(if (i.approved) "Approved" else "Rejected")
                        if (i.feeSignature != null) Tag("Tap to see your fee on Solana", color = WrkColors.mintInk)
                    }
                    if (i.feeUsd > 0) Figure(i.feeUsd, WrkType.figureInline, WrkColors.positive)
                }
            }
        }
    }
}
