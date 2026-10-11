package com.wrk.app.upload

import android.content.Context
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.wrk.app.BuildConfig
import com.wrk.app.PendingCapture
import com.wrk.app.WrkContainer
import com.wrk.app.account.Account
import com.wrk.app.episode.EpisodeState
import com.wrk.app.episode.SelfReport
import com.wrk.app.episode.buildEpisode
import com.wrk.app.wallet.SendResult

/** The foreground half of submitting: seal the take, get the payout approved if needed, hand over to the queue. */
class SubmissionService(private val context: Context, private val c: WrkContainer) {

    /** Returns the episode id. Throws EpisodeException with a message the contributor can act on. */
    suspend fun submit(p: PendingCapture, account: Account, report: SelfReport): String {
        val built = buildEpisode(
            capture = p.raw, dir = c.episodes.dir(p.episodeId), bounty = p.bounty, contributor = account.address,
            assetId = "asset_" + c.accounts.installId(), selfReport = report,
            clientVersion = BuildConfig.VERSION_NAME, cluster = BuildConfig.SOLANA_CLUSTER, episodeId = p.episodeId, liveness = p.liveness, location = p.location,
        )
        c.episodes.write(
            built.episodeId,
            EpisodeState(
                bountyId = p.bounty.id, bountyTitle = p.bounty.title, perEpisodeUsd = p.bounty.perEpisodeUsd,
                overlay = p.overlay, createdAt = System.currentTimeMillis(), accountKind = if (account is Account.Wallet) "wallet" else "email",
            ),
        )
        c.pending = null
        // Wrk records every take on-chain for its contributor, whatever kind of account they signed in with.
        UploadWorker.enqueue(context, built.episodeId)
        return built.episodeId
    }

    /** Re-run the queue for an episode (after reconnecting, or after signing in again). */
    fun retry(id: String) {
        c.episodes.update(id) { it.copy(error = null, waiting = false) }
        UploadWorker.enqueue(context, id)
    }
}
