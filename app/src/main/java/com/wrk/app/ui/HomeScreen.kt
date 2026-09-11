package com.wrk.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.wrk.app.data.Bounty
import com.wrk.app.design.Chip
import com.wrk.app.design.Figure
import com.wrk.app.design.FieldCard
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkType

@Composable
fun HomeScreen(bounties: List<Bounty>, earnedUsd: Double, onOpen: (Bounty) -> Unit, modifier: Modifier = Modifier) {
    var filter by remember { mutableStateOf<String?>(null) }
    val shown = bounties.filter { filter == null || it.task == filter }
    LazyColumn(
        modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(WrkShape.gutter),
        verticalArrangement = Arrangement.spacedBy(WrkShape.stack),
    ) {
        item {
            Column(Modifier.padding(top = 12.dp)) {
                Text("Wrk", style = WrkType.title, color = WrkColors.foreground)
                Tag("Earned so far", modifier = Modifier.padding(top = 20.dp))
                Figure(earnedUsd, WrkType.figureLead, knockDownCents = true)
            }
        }
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item { Chip("All tasks", filter == null) { filter = null } }
                items(bounties.distinctBy { it.task }) { b -> Chip(b.title.substringBefore(',').take(24), filter == b.task) { filter = b.task } }
            }
        }
        items(shown, key = { it.id }) { b -> BountyCard(b) { onOpen(b) } }
    }
}

@Composable
private fun BountyCard(b: Bounty, onClick: () -> Unit) {
    PaperCard(Modifier.fillMaxWidth(), onClick = onClick) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(b.title, style = WrkType.title, color = WrkColors.foreground)
            Text(b.taskSpec, style = WrkType.body, color = WrkColors.muted, maxLines = 2)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FieldCard(WrkColors.mint) { Figure(b.perEpisodeUsd, WrkType.figureInline, WrkColors.mintInk, unit = "per take") }
                FieldCard(WrkColors.paperSunk) { Text("${b.minDurationS}–${b.maxDurationS} s", style = WrkType.figureInline, color = WrkColors.foreground) }
            }
        }
    }
}
