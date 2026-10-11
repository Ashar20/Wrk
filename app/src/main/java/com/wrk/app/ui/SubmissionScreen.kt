package com.wrk.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import com.wrk.app.BuildConfig
import com.wrk.app.design.ButterButton
import com.wrk.app.design.FieldCard
import com.wrk.app.design.Figure
import com.wrk.app.design.InkButton
import com.wrk.app.design.InkCard
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkType
import com.wrk.app.episode.EpisodeState
import com.wrk.app.episode.EpisodeStatus
import com.wrk.app.episode.EpisodeStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal fun explorerUrl(signature: String) = "https://explorer.solana.com/tx/$signature?cluster=${BuildConfig.SOLANA_CLUSTER}"

/** Plain-language progress for one take: uploading, checking, payment, and finally the receipt. */
@Composable
fun SubmissionScreen(
    id: String,
    store: EpisodeStore,
    onRetry: () -> Unit,
    onRecordAgain: () -> Unit,
    onDelete: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by produceState<EpisodeState?>(store.state(id), id) {
        while (true) { value = store.state(id); delay(1000) }
    }
    val s = state
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        PaperButton("Done", onBack)
        if (s == null) {
            Text("This take is no longer on the phone.", style = WrkType.body, color = WrkColors.muted)
            return@Column
        }
        Text(s.bountyTitle, style = WrkType.title, color = WrkColors.foreground)

        when (s.status) {
            EpisodeStatus.Paid -> {
                InkCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("You earned", style = WrkType.label, color = WrkColors.onInkMuted)
                        Figure(s.paidUsd, WrkType.figureHero, WrkColors.onInk)
                        Text("Paid to your payment account", style = WrkType.body, color = WrkColors.onInkMuted)
                        if (s.trustLevel == "attested") Text("Signed by a verified phone", style = WrkType.label, color = WrkColors.onInkMuted)
                    }
                }
                Receipts(takeReceipts(s))
                ResultPanels(id, s, store)
                InkButton("Record another", onRecordAgain, Modifier.fillMaxWidth())
            }
            EpisodeStatus.Rejected -> {
                PaperCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Not accepted this time", style = WrkType.title, color = WrkColors.foreground)
                        s.reasons.ifEmpty { listOf("This take didn't meet the task's requirements.") }.forEach {
                            Text(it, style = WrkType.body, color = WrkColors.muted)
                        }
                    }
                }
                Text(
                    "Nothing was charged to you. Most rejections are a framing problem: watch the skeleton while you record and keep your hands inside the box.",
                    style = WrkType.body, color = WrkColors.muted,
                )
                ResultPanels(id, s, store)
                InkButton("Record again", onRecordAgain, Modifier.fillMaxWidth())
                PaperButton("Delete this take", onDelete, Modifier.fillMaxWidth())
            }
            else -> {
                Steps(s)
                Receipts(takeReceipts(s))
                if (s.waiting) {
                    FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Waiting for a connection", style = WrkType.title, color = WrkColors.butterInk)
                            Text("Your take is saved on this phone and will go as soon as you're back online.", style = WrkType.body, color = WrkColors.butterInk)
                        }
                    }
                }
                s.error?.let {
                    FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(it, style = WrkType.body, color = WrkColors.butterInk)
                            ButterButton("Try again", onRetry, Modifier.fillMaxWidth())
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Steps(s: EpisodeState) {
    val stage = when (s.status) { EpisodeStatus.NotSubmitted -> 0; EpisodeStatus.Submitted, EpisodeStatus.Validating, EpisodeStatus.InReview -> 1; else -> 2 }
    PaperCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            listOf("Sending your take", if (s.status == EpisodeStatus.InReview) "A reviewer is checking your take" else "Checking it against the task", "Processing payment").forEachIndexed { i, label ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    val color = when { i < stage -> WrkColors.positive; i == stage -> WrkColors.ink; else -> WrkColors.paperSunk }
                    Column(Modifier.size(14.dp).clip(CircleShape).background(color)) {}
                    Text(label, style = WrkType.body, color = if (i <= stage) WrkColors.foreground else WrkColors.subtle)
                }
            }
            Tag(if (s.status == EpisodeStatus.InReview) "This one was close, so a person is looking at it. It can take a little while." else "Usually under a minute")
        }
    }
}

/** The transactions behind a take, in the order they happened. */
internal fun takeReceipts(s: EpisodeState) = listOfNotNull(
    (s.recordTx ?: s.anchorSignature)?.let { Receipt("Take recorded on Solana", it) },
    s.paymentSignature?.let { Receipt("Payment to you", it) },
)
