package com.wrk.app.profile

import com.wrk.app.account.Account
import com.wrk.app.account.shortAddress
import com.wrk.app.episode.EpisodeStatus
import com.wrk.app.episode.StoredEpisode

/** The numbers at the top of a contributor's profile, worked out from the takes on this phone. */
data class ProfileStats(
    val takes: Int,
    /** Paid, or accepted and waiting for payment. */
    val accepted: Int,
    val refused: Int,
    /** Still on their way: sending, being checked, or waiting on a reviewer. */
    val inProgress: Int,
    val earnedUsd: Double,
    /** Share of decided takes that were accepted, as a whole percent. Null until one has been decided. */
    val acceptancePercent: Int?,
) {
    companion object {
        fun from(takes: List<StoredEpisode>): ProfileStats {
            val accepted = takes.count { it.state.status == EpisodeStatus.Paid || it.state.status == EpisodeStatus.Accepted }
            val refused = takes.count { it.state.status == EpisodeStatus.Rejected }
            val decided = accepted + refused
            return ProfileStats(
                takes = takes.size, accepted = accepted, refused = refused, inProgress = takes.size - decided,
                earnedUsd = takes.filter { it.state.status == EpisodeStatus.Paid }.sumOf { it.state.paidUsd },
                acceptancePercent = if (decided == 0) null else Math.round(100.0 * accepted / decided).toInt(),
            )
        }
    }
}

/** What to call someone before they've picked a name: the start of their email, or a short form of their address. */
fun defaultName(account: Account): String = when (account) {
    is Account.Email -> account.email.substringBefore('@').replace(Regex("[._-]+"), " ").trim().split(' ').filter { it.isNotBlank() }
        .joinToString(" ") { w -> w.lowercase().replaceFirstChar { it.uppercase() } }.ifBlank { account.email }
    is Account.Wallet -> "Wallet ${shortAddress(account.address)}"
}

/** Up to two letters for the avatar. */
fun initials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotBlank() && it.first().isLetterOrDigit() }
    return when {
        parts.isEmpty() -> "?"
        parts.size == 1 -> parts[0].take(2).uppercase()
        else -> "${parts.first().first()}${parts.last().first()}".uppercase()
    }
}

/** Names are shown to the person only, but keep them tidy and a sensible length. */
fun cleanName(raw: String): String = raw.trim().replace(Regex("\\s+"), " ").take(40)
