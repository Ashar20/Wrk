package com.wrk.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wrk.app.account.Account
import com.wrk.app.account.Role
import com.wrk.app.account.label
import com.wrk.app.design.FieldCard
import com.wrk.app.design.Figure
import com.wrk.app.design.InkButton
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkTextField
import com.wrk.app.design.WrkType
import com.wrk.app.episode.EpisodeStatus
import com.wrk.app.episode.StoredEpisode
import com.wrk.app.profile.ProfileStats
import com.wrk.app.profile.cleanName
import com.wrk.app.profile.initials
import com.wrk.app.roles.BuyerBounty
import com.wrk.app.roles.ReviewHistory
import com.wrk.app.trust.TrustReport
import java.text.DateFormat
import java.util.Date

private fun statusText(s: EpisodeStatus) = when (s) {
    EpisodeStatus.NotSubmitted -> "Sending"
    EpisodeStatus.Submitted, EpisodeStatus.Validating -> "Being checked"
    EpisodeStatus.InReview -> "With a reviewer"
    EpisodeStatus.Accepted -> "Accepted, payment on its way"
    EpisodeStatus.Paid -> "Paid"
    EpisodeStatus.Rejected -> "Not accepted"
}

/** Who you are on Wrk: a name, how much Wrk trusts you, and what you've done. */
@Composable
fun ProfileScreen(
    account: Account,
    role: Role,
    name: String,
    onRename: (String) -> Unit,
    trust: TrustReport?,
    onLiveCheck: () -> Unit,
    takes: List<StoredEpisode>,
    reviews: ReviewHistory?,
    tasks: List<BuyerBounty>?,
    onOpenTake: (StoredEpisode) -> Unit,
    onAccountSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var editing by remember { mutableStateOf(false) }
    var draft by remember(name) { mutableStateOf(name) }
    val dates = remember { DateFormat.getDateInstance(DateFormat.MEDIUM) }
    val stats = remember(takes) { ProfileStats.from(takes) }

    LazyColumn(modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        item {
            Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Box(Modifier.size(64.dp).clip(CircleShape).background(WrkColors.ink), contentAlignment = Alignment.Center) {
                    Text(initials(name), style = WrkType.title.copy(fontSize = 22.sp), color = WrkColors.onInk)
                }
                Column(Modifier.weight(1f)) {
                    Text(name, style = WrkType.title.copy(fontSize = 24.sp), color = WrkColors.foreground, maxLines = 1)
                    Tag("${account.label} · ${role.label}")
                }
            }
        }
        item {
            if (editing) {
                PaperCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
                        Tag("What should we call you?")
                        WrkTextField(draft, { draft = it.take(40) }, "Your name")
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            InkButton("Save", { onRename(cleanName(draft)); editing = false }, Modifier.weight(1f), enabled = cleanName(draft).isNotEmpty())
                            PaperButton("Cancel", { draft = name; editing = false }, Modifier.weight(1f))
                        }
                    }
                }
            } else PaperButton("Change name", { editing = true }, Modifier.fillMaxWidth())
        }

        item { TrustCard(trust, onLiveCheck) }

        when (role) {
            Role.Contributor -> {
                item {
                    PaperCard(Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Tag("Earned so far")
                            Figure(stats.earnedUsd, WrkType.figureLead, knockDownCents = true)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
                                Stat("Takes", "${stats.takes}", Modifier.weight(1f))
                                Stat("Accepted", "${stats.accepted}", Modifier.weight(1f))
                                Stat("Acceptance", stats.acceptancePercent?.let { "$it%" } ?: "—", Modifier.weight(1f))
                            }
                        }
                    }
                }
                item { Text("History", style = WrkType.title, color = WrkColors.foreground, modifier = Modifier.padding(top = 8.dp)) }
                if (takes.isEmpty()) item { FieldCard(WrkColors.paperSunk, Modifier.fillMaxWidth()) { Text("Your takes will appear here once you record one.", style = WrkType.body, color = WrkColors.muted) } }
                items(takes, key = { it.id }) { e ->
                    PaperCard(Modifier.fillMaxWidth(), onClick = { onOpenTake(e) }) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(e.state.bountyTitle, style = WrkType.body.copy(fontWeight = FontWeight.SemiBold), color = WrkColors.foreground, maxLines = 1)
                                Tag("${dates.format(Date(e.state.createdAt))} · ${statusText(e.state.status)}")
                            }
                            if (e.state.status == EpisodeStatus.Paid) Figure(e.state.paidUsd, WrkType.figureInline, WrkColors.positive)
                        }
                    }
                }
            }
            Role.Verifier -> {
                item {
                    PaperCard(Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Tag("Earned from reviews")
                            Figure(reviews?.earnedUsd ?: 0.0, WrkType.figureLead, knockDownCents = true)
                            Stat("Reviews", "${reviews?.items?.size ?: 0}", Modifier)
                        }
                    }
                }
                item { Text("Reviews", style = WrkType.title, color = WrkColors.foreground, modifier = Modifier.padding(top = 8.dp)) }
                if (reviews?.items.isNullOrEmpty()) item { FieldCard(WrkColors.paperSunk, Modifier.fillMaxWidth()) { Text("Your decisions will appear here.", style = WrkType.body, color = WrkColors.muted) } }
                items(reviews?.items.orEmpty(), key = { it.episodeId }) { r ->
                    PaperCard(Modifier.fillMaxWidth()) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Column(Modifier.weight(1f)) {
                                Text(r.bountyTitle, style = WrkType.body.copy(fontWeight = FontWeight.SemiBold), color = WrkColors.foreground, maxLines = 1)
                                Tag("${dates.format(Date(r.decidedAt * 1000))} · ${if (r.approved) "Approved" else "Rejected"}")
                            }
                            if (r.feeUsd > 0) Figure(r.feeUsd, WrkType.figureInline, WrkColors.positive)
                        }
                    }
                }
            }
            Role.Buyer -> {
                item { Text("Your tasks", style = WrkType.title, color = WrkColors.foreground, modifier = Modifier.padding(top = 8.dp)) }
                val mine = tasks.orEmpty().filter { it.ownerIsYou }
                if (mine.isEmpty()) item { FieldCard(WrkColors.paperSunk, Modifier.fillMaxWidth()) { Text("Tasks you post will appear here.", style = WrkType.body, color = WrkColors.muted) } }
                items(mine, key = { it.id }) { b ->
                    PaperCard(Modifier.fillMaxWidth()) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Column(Modifier.weight(1f)) {
                                Text(b.title, style = WrkType.body.copy(fontWeight = FontWeight.SemiBold), color = WrkColors.foreground, maxLines = 1)
                                Tag("${b.accepted} of ${b.minEpisodes} takes accepted")
                            }
                            Figure(b.spendUsd, WrkType.figureInline, WrkColors.foreground)
                        }
                    }
                }
            }
        }

        item { PaperButton("Account and sign-in", onAccountSettings, Modifier.fillMaxWidth().padding(top = 8.dp)) }
    }
}

@Composable
private fun Stat(label: String, value: String, modifier: Modifier) {
    Column(modifier) {
        Tag(label)
        Text(value, style = WrkType.figureInline.copy(fontSize = 22.sp), color = WrkColors.foreground)
    }
}
