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
            clientVersion = BuildConfig.VERSION_NAME, cluster = BuildConfig.SOLANA_CLUSTER, episodeId = p.episodeId,
        )
        c.episodes.write(
            built.episodeId,
            EpisodeState(
                bountyId = p.bounty.id, bountyTitle = p.bounty.title, perEpisodeUsd = p.bounty.perEpisodeUsd,
                overlay = p.overlay, createdAt = System.currentTimeMillis(), accountKind = if (account is Account.Wallet) "wallet" else "email",
            ),
        )
        c.pending = null
        // Email accounts are anchored by Wrk on the server; wallet users approve it themselves, from the status screen.
        if (account is Account.Email) UploadWorker.enqueue(context, built.episodeId)
        return built.episodeId
    }

    /**
     * Wallet users: record the take in its task's escrow. Wrk builds the transaction and pays its fees; the wallet only
     * signs. Then the upload starts. Returns a message to show the person, or null on success.
     */
    suspend fun approvePayout(id: String, account: Account.Wallet, sender: ActivityResultSender): String? {
        val manifest = c.episodes.manifest(id) ?: return "This take is no longer on the phone."
        val st = c.episodes.state(id) ?: return "This take is no longer on the phone."
        if (st.anchorSignature != null) { UploadWorker.enqueue(context, id); return null }
        val hash = (manifest.map["manifest_hash"] as com.wrk.app.episode.JsonStr).value
        return when (val r = c.api.anchorTx(st.bountyId, id, hash, account.address)) {
            AnchorTxResult.NotNeeded -> {
                c.episodes.update(id) { it.copy(anchorSignature = "not-required", error = null, waiting = false) }
                UploadWorker.enqueue(context, id); null
            }
            is AnchorTxResult.Refused -> r.message
            is AnchorTxResult.Retry -> r.message
            is AnchorTxResult.Ready -> when (val sent = c.wallet.signAndSend(sender, r.tx)) {
                is SendResult.Sent -> {
                    c.episodes.update(id) { it.copy(anchorSignature = sent.signature, error = null, waiting = false) }
                    UploadWorker.enqueue(context, id); null
                }
                SendResult.NoWalletInstalled -> "Your wallet app isn't available. Open it once, then try again."
                is SendResult.Failed -> sent.message
            }
        }
    }

    /** Re-run the queue for an episode (after reconnecting, or after signing in again). */
    fun retry(id: String) {
        c.episodes.update(id) { it.copy(error = null, waiting = false) }
        UploadWorker.enqueue(context, id)
    }
}
