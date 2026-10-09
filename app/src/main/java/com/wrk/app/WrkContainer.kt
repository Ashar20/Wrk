package com.wrk.app

import android.content.Context
import com.wrk.app.account.Account
import com.wrk.app.account.AccountStore
import com.wrk.app.account.EncryptedKeyValue
import com.wrk.app.device.DeviceApi
import com.wrk.app.device.DeviceKey
import com.wrk.app.episode.EpisodeStore
import com.wrk.app.roles.JsonApi
import com.wrk.app.upload.EpisodeApi
import com.wrk.app.upload.HttpEpisodeApi
import com.wrk.app.upload.SubmissionProcessor
import com.wrk.app.episode.RawCapture
import com.wrk.app.data.Bounty
import com.wrk.app.wallet.WalletManager
import java.io.File

/** A take that has been recorded but not yet reviewed or submitted. */
class PendingCapture(
    val episodeId: String,
    val raw: RawCapture,
    val bounty: Bounty,
    /** How the live hand overlay behaved during this take, for the technical details. */
    val overlay: com.wrk.app.episode.OverlayStats? = null,
    /** The live-check prompts this take answered, for tasks that have one. */
    val liveness: com.wrk.app.capture.LivenessClaim? = null,
    /** Roughly where the take was made (about a kilometre), when the phone could say. */
    val location: com.wrk.app.location.CoarseLocation? = null,
)

/** Hand-wired dependencies, shared by the UI and the background upload worker. */
class WrkContainer private constructor(private val app: Context) {
    val accounts = AccountStore(EncryptedKeyValue(app))
    val episodes = EpisodeStore(File(app.filesDir, "episodes"))
    val api: EpisodeApi = HttpEpisodeApi(BuildConfig.API_BASE)
    val wallet = WalletManager(accounts)
    /** This phone's hardware key and its standing with the validator. */
    val device = DeviceKey(accounts, DeviceApi(JsonApi(BuildConfig.API_BASE, { null })))

    /** Survives navigation between capture and review; deliberately not persisted (the video already is). */
    @Volatile var pending: PendingCapture? = null

    init { episodes.pruneOrphans() }

    fun processor() = SubmissionProcessor(episodes, api, bearerFor = { contributor ->
        // Only an email session for this very payment account may speak for it.
        (accounts.load() as? Account.Email)?.takeIf { it.address == contributor }?.token
    }, signer = device)

    companion object {
        @Volatile private var instance: WrkContainer? = null
        fun get(context: Context): WrkContainer =
            instance ?: synchronized(this) { instance ?: WrkContainer(context.applicationContext).also { instance = it } }
    }
}
