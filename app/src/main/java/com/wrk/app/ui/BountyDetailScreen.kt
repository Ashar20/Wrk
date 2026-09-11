package com.wrk.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.wrk.app.data.Bounty
import com.wrk.app.design.Figure
import com.wrk.app.design.KnobBar
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Panel
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkType

private fun sensors(b: Bounty) = b.requiredModalities.joinToString(" · ") {
    when (it) { "rgb" -> "Camera"; "imu" -> "Motion"; "audio" -> "Microphone"; else -> it }
}

@Composable
fun BountyDetailScreen(b: Bounty, onStart: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter)) {
        PaperButton("Back", onBack)
        Spacer(Modifier.height(WrkShape.stack))
        Panel(WrkColors.mint, Modifier.fillMaxWidth()) {
            Column {
                Text(b.title, style = WrkType.title, color = WrkColors.mintInk)
                Spacer(Modifier.height(20.dp))
                Tag("This take pays", WrkColors.mintInk)
                Figure(b.perEpisodeUsd, WrkType.figureHero, WrkColors.mintInk, unit = "per take")
            }
        }
        Spacer(Modifier.height(WrkShape.stack))
        PaperCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Tag("What to do")
                Text(b.taskSpec, style = WrkType.body, color = WrkColors.foreground)
            }
        }
        Spacer(Modifier.height(WrkShape.stack))
        Row(horizontalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
            PaperCard(Modifier.weight(1f)) { Column { Tag("Length"); Text("${b.minDurationS}–${b.maxDurationS} s", style = WrkType.figureInline, color = WrkColors.foreground) } }
            PaperCard(Modifier.weight(1f)) { Column { Tag("Sensors"); Text(sensors(b), style = WrkType.body, color = WrkColors.foreground) } }
        }
        Spacer(Modifier.height(WrkShape.stack))
        PaperCard(Modifier.fillMaxWidth()) {
            Text(
                "Hold the phone at head height or strap it to your forehead so the camera sees what your hands see. Move your head naturally while you work.",
                style = WrkType.body, color = WrkColors.muted,
            )
        }
        Spacer(Modifier.height(24.dp))
        KnobBar("Start recording", onStart)
    }
}
