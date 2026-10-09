package com.wrk.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.wrk.app.PendingCapture
import com.wrk.app.account.Account
import com.wrk.app.data.Bounty
import com.wrk.app.design.FieldCard
import com.wrk.app.design.InkButton
import com.wrk.app.design.PaperButton
import com.wrk.app.design.Panel
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkType
import com.wrk.app.trust.LiveVerify
import com.wrk.app.upload.LiveCheckService

/** The standalone live check is recorded like a take, but it isn't one: nothing is paid and nothing is kept. */
val LiveCheckTask = Bounty(
    id = "liveness_check", title = "Verify you're live", taskSpec = "Look where the app asks, a few times, so Wrk can tell this is you and not a recording.",
    task = "liveness", requiredModalities = listOf("rgb", "imu"), minDurationS = 8, maxDurationS = 30, perEpisodeUsd = 0.0,
    deadline = Long.MAX_VALUE, liveCheck = true,
)

/** Sends the recording for checking and says how it went. */
@Composable
fun LiveCheckRunScreen(pending: PendingCapture, account: Account, service: LiveCheckService, onTryAgain: () -> Unit, onDone: () -> Unit, modifier: Modifier = Modifier) {
    var result by remember { mutableStateOf<LiveVerify?>(null) }
    LaunchedEffect(pending.episodeId) { result = service.verify(pending, account) }

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        Text("Live check", style = WrkType.title, color = WrkColors.foreground)
        when (val r = result) {
            null -> Panel(WrkColors.lilac, Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Checking your movements…", style = WrkType.title, color = WrkColors.lilacInk)
                    Text("Wrk is comparing what the camera saw with how your phone moved. This takes about half a minute.", style = WrkType.body, color = WrkColors.lilacInk)
                }
            }
            is LiveVerify.Done -> {
                if (r.passed) {
                    Panel(WrkColors.mint, Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("You're verified live", style = WrkType.title, color = WrkColors.mintInk)
                            Text("${r.matched} of ${r.total} movements matched. This counts towards your trust score for the next 30 days.", style = WrkType.body, color = WrkColors.mintInk)
                            r.trust?.let { Text("Your trust score is now ${it.score}.", style = WrkType.body, color = WrkColors.mintInk) }
                        }
                    }
                    InkButton("Done", onDone, Modifier.fillMaxWidth())
                } else {
                    FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("That didn't match", style = WrkType.title, color = WrkColors.butterInk)
                            Text("Only ${r.matched} of ${r.total} movements showed up in both the video and your phone's motion. Hold the phone at head height and make each movement as soon as it appears.", style = WrkType.body, color = WrkColors.butterInk)
                        }
                    }
                    InkButton("Try again", onTryAgain, Modifier.fillMaxWidth())
                    PaperButton("Not now", onDone, Modifier.fillMaxWidth())
                }
            }
            is LiveVerify.Refused -> {
                FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(r.message, style = WrkType.body, color = WrkColors.butterInk) }
                PaperButton("Back", onDone, Modifier.fillMaxWidth())
            }
            is LiveVerify.Retry -> {
                FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(r.message, style = WrkType.body, color = WrkColors.butterInk) }
                InkButton("Try again", onTryAgain, Modifier.fillMaxWidth())
                PaperButton("Back", onDone, Modifier.fillMaxWidth())
            }
        }
    }
}
