package com.wrk.app.upload

import com.wrk.app.BuildConfig
import com.wrk.app.PendingCapture
import com.wrk.app.WrkContainer
import com.wrk.app.account.Account
import com.wrk.app.episode.EpisodeException
import com.wrk.app.episode.JsonStr
import com.wrk.app.episode.buildEpisode
import com.wrk.app.trust.LiveVerify
import com.wrk.app.ui.LiveCheckTask

/** Seals a recorded live check, signs it with this phone's key, sends it, and throws the recording away. */
class LiveCheckService(private val c: WrkContainer) {
    suspend fun verify(p: PendingCapture, account: Account): LiveVerify {
        return try {
            val built = buildEpisode(
                capture = p.raw, dir = c.episodes.dir(p.episodeId), bounty = LiveCheckTask, contributor = account.address,
                assetId = "asset_" + c.accounts.installId(), selfReport = null, clientVersion = BuildConfig.VERSION_NAME,
                cluster = BuildConfig.SOLANA_CLUSTER, episodeId = p.episodeId, liveness = p.liveness, location = p.location,
            )
            val hash = (built.manifest.map["manifest_hash"] as JsonStr).value
            val device = c.device.sign(p.episodeId, hash)
            c.api.verifyLive(java.io.File(built.dir, "manifest.json").readText(), built.rgb, built.imu, device)
        } catch (e: EpisodeException) {
            LiveVerify.Refused(e.message ?: "That recording couldn't be used.")
        } finally {
            c.pending = null
            c.episodes.delete(p.episodeId) // a live check isn't a take: nothing is kept
        }
    }
}
