package com.wrk.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.wrk.app.design.FieldCard
import com.wrk.app.design.Figure
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkType
import com.wrk.app.episode.EpisodeStatus
import com.wrk.app.episode.EpisodeStore
import com.wrk.app.episode.StoredEpisode
import kotlinx.coroutines.delay

private fun label(s: EpisodeStatus) = when (s) {
    EpisodeStatus.NotSubmitted -> "Sending"
    EpisodeStatus.Submitted, EpisodeStatus.Validating -> "Checking"
    EpisodeStatus.InReview -> "A reviewer is checking"
    EpisodeStatus.Accepted -> "Processing payment"
    EpisodeStatus.Paid -> "Paid"
    EpisodeStatus.Rejected -> "Not accepted"
}

@Composable
fun ActivityScreen(store: EpisodeStore, onOpen: (StoredEpisode) -> Unit, modifier: Modifier = Modifier) {
    val items by produceState(store.list()) { while (true) { value = store.list(); delay(1500) } }
    LazyColumn(modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        item {
            Column(Modifier.padding(top = 12.dp)) {
                Text("Activity", style = WrkType.title, color = WrkColors.foreground)
                Tag("Earned so far", modifier = Modifier.padding(top = 20.dp))
                Figure(items.filter { it.state.status == EpisodeStatus.Paid }.sumOf { it.state.paidUsd }, WrkType.figureLead, knockDownCents = true)
            }
        }
        if (items.isEmpty()) item {
            FieldCard(WrkColors.paperSunk, Modifier.fillMaxWidth()) {
                Text("Your takes will show up here once you record one.", style = WrkType.body, color = WrkColors.muted)
            }
        }
        items(items, key = { it.id }) { e ->
            PaperCard(Modifier.fillMaxWidth(), onClick = { onOpen(e) }) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Text(e.state.bountyTitle, style = WrkType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = WrkColors.foreground, maxLines = 1)
                        Tag(label(e.state.status))
                    }
                    if (e.state.status == EpisodeStatus.Paid) Figure(e.state.paidUsd, WrkType.figureInline, WrkColors.positive)
                }
            }
        }
    }
}
