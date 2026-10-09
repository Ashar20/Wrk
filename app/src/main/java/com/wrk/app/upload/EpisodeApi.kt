package com.wrk.app.upload

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.wrk.app.device.DeviceSignature
import com.wrk.app.trust.LiveVerify
import com.wrk.app.trust.parseTrust
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What the validator says about an episode. Mirrors the server's public view; no thresholds in it. */
data class EpisodeView(
    val status: String, // scoring | scored | failed
    val accepted: Boolean?,
    val reasons: List<String>,
    val paymentSignature: String?,
    val paidUsd: Double?,
    val paymentError: String?,
    val scoringError: String?,
    val framing: Double? = null,
    val plausibility: Double? = null,
    val handsVisiblePercent: Double? = null,
    val motionCorr: Double? = null,
    val validatorScore: Double? = null,
    val duplicateOf: String? = null,
    val manifestIntact: Boolean? = null,
    val streamsIntact: Boolean? = null,
    /** "attested" when the take was signed by a verified phone; otherwise "heuristic". Decided by the validator. */
    val trustLevel: String? = null,
    /** Present only for tasks with a live check. */
    val liveness: LiveResult? = null,
    /** The contributor's trust score (0 to 100) when the take was last looked at. */
    val sybilScore: Int? = null,
)

/** How many of the head movements asked for showed up in both the video and the phone's motion. */
data class LiveResult(val passed: Boolean, val matched: Int, val total: Int)

sealed interface UploadResult {
    data class Ok(val view: EpisodeView) : UploadResult
    /** Offline, timeout or a server hiccup: keep the take and try again. */
    data class Retry(val why: String) : UploadResult
    /** The validator refused the bytes; trying again will not change that. */
    data class Refused(val reasons: List<String>) : UploadResult
    data object SignInExpired : UploadResult
    /** The validator has no record of this phone (it was reset). Register again and retry. */
    data object DeviceUnknown : UploadResult
}

/** The server's answer to "give me the transaction that records this take on-chain". */
sealed interface AnchorTxResult {
    class Ready(val tx: ByteArray) : AnchorTxResult
    /** This validator isn't running payments, so there is nothing to sign. */
    data object NotNeeded : AnchorTxResult
    /** The server won't issue one, with a reason the person can read. */
    data class Refused(val message: String) : AnchorTxResult
    /** Couldn't reach the server. Try again. */
    data class Retry(val message: String) : AnchorTxResult
}

interface EpisodeApi {
    suspend fun upload(manifestJson: String, rgb: File, imu: File, anchorSignature: String?, bearer: String?, device: DeviceSignature? = null): UploadResult
    /** Null when the validator can't be reached right now. */
    suspend fun fetch(episodeId: String): EpisodeView?
    /** The aligned flow/gyro traces as JSON text, or null when unavailable. */
    suspend fun traces(episodeId: String): String? = null
    /** A standalone live check: the recording and its prompts, signed by this phone. Not a take; nothing is paid. */
    suspend fun verifyLive(manifestJson: String, rgb: File, imu: File, device: DeviceSignature?): LiveVerify = LiveVerify.Retry("Live checks aren't available.")

    /** The transaction a wallet signs to record a take in its task's escrow. Fees and rent are covered by Wrk. */
    suspend fun anchorTx(bountyId: String, episodeId: String, manifestHash: String, contributor: String): AnchorTxResult = AnchorTxResult.NotNeeded

    /** Sends the saved live-prediction strip. Returns true once the server has it. */
    suspend fun uploadPredictions(episodeId: String, json: String): Boolean = true
}

class HttpEpisodeApi(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(5, TimeUnit.MINUTES).writeTimeout(2, TimeUnit.MINUTES).readTimeout(60, TimeUnit.SECONDS).build(),
) : EpisodeApi {

    override suspend fun upload(manifestJson: String, rgb: File, imu: File, anchorSignature: String?, bearer: String?, device: DeviceSignature?): UploadResult =
        withContext(Dispatchers.IO) {
            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("manifest", manifestJson)
                .apply { if (anchorSignature != null) addFormDataPart("anchor_signature", anchorSignature) }
                .apply { if (device != null) { addFormDataPart("device_id", device.deviceId); addFormDataPart("device_signature", device.signatureB64) } }
                .addFormDataPart("rgb", "rgb.mp4", rgb.asRequestBody("video/mp4".toMediaType()))
                .addFormDataPart("imu", "imu.bin", imu.asRequestBody("application/octet-stream".toMediaType()))
                .build()
            val req = Request.Builder().url("$baseUrl/episodes").post(body)
                .apply { if (bearer != null) header("Authorization", "Bearer $bearer") }.build()
            try {
                client.newCall(req).execute().use { r ->
                    val text = r.body?.string().orEmpty()
                    val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
                    when {
                        r.isSuccessful -> UploadResult.Ok(parse(json))
                        r.code == 401 -> UploadResult.SignInExpired
                        r.code == 400 && json.optString("error").contains("isn't registered") -> UploadResult.DeviceUnknown
                        r.code == 422 -> UploadResult.Refused(strings(json.optJSONArray("failures")).ifEmpty { listOf("The upload didn't match what was recorded.") })
                        r.code in 400..499 && r.code != 408 && r.code != 429 ->
                            UploadResult.Refused(listOf(json.optString("error").ifBlank { "The upload was refused." }))
                        else -> UploadResult.Retry("Server answered ${r.code}")
                    }
                }
            } catch (e: IOException) {
                UploadResult.Retry(e.message ?: "No connection")
            }
        }

    override suspend fun fetch(episodeId: String): EpisodeView? = withContext(Dispatchers.IO) {
        try {
            client.newCall(Request.Builder().url("$baseUrl/episodes/$episodeId").build()).execute().use { r ->
                if (!r.isSuccessful) null else parse(JSONObject(r.body!!.string()))
            }
        } catch (e: Exception) { null }
    }

    override suspend fun verifyLive(manifestJson: String, rgb: File, imu: File, device: DeviceSignature?): LiveVerify = withContext(Dispatchers.IO) {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("manifest", manifestJson)
            .apply { if (device != null) { addFormDataPart("device_id", device.deviceId); addFormDataPart("device_signature", device.signatureB64) } }
            .addFormDataPart("rgb", "rgb.mp4", rgb.asRequestBody("video/mp4".toMediaType()))
            .addFormDataPart("imu", "imu.bin", imu.asRequestBody("application/octet-stream".toMediaType()))
            .build()
        try {
            client.newCall(Request.Builder().url("$baseUrl/liveness/verify").post(body).build()).execute().use { r ->
                val json = runCatching { JSONObject(r.body?.string().orEmpty()) }.getOrDefault(JSONObject())
                when {
                    r.isSuccessful -> LiveVerify.Done(json.optBoolean("passed"), json.optInt("matched"), json.optInt("total"), json.optJSONObject("trust")?.let { runCatching { parseTrust(it) }.getOrNull() })
                    r.code == 429 || r.code >= 500 -> LiveVerify.Retry(json.optString("error").ifBlank { "Wrk had a problem. Try again in a moment." })
                    else -> LiveVerify.Refused(json.optString("error").ifBlank { "The live check couldn't be accepted." })
                }
            }
        } catch (e: IOException) {
            LiveVerify.Retry("Couldn't reach Wrk. Check your connection and try again.")
        }
    }

    override suspend fun anchorTx(bountyId: String, episodeId: String, manifestHash: String, contributor: String): AnchorTxResult =
        withContext(Dispatchers.IO) {
            val body = JSONObject().put("bounty_id", bountyId).put("episode_id", episodeId).put("manifest_hash", manifestHash).put("contributor", contributor)
            try {
                client.newCall(Request.Builder().url("$baseUrl/anchor/tx").post(body.toString().toRequestBody("application/json".toMediaType())).build()).execute().use { r ->
                    val json = runCatching { JSONObject(r.body?.string().orEmpty()) }.getOrDefault(JSONObject())
                    when {
                        r.isSuccessful -> AnchorTxResult.Ready(android.util.Base64.decode(json.getString("tx"), android.util.Base64.DEFAULT))
                        r.code == 501 -> AnchorTxResult.NotNeeded
                        r.code in 400..499 -> AnchorTxResult.Refused(json.optString("error").ifBlank { "This take can't be recorded right now." })
                        else -> AnchorTxResult.Retry("Wrk had a problem. Try again in a moment.")
                    }
                }
            } catch (e: IOException) {
                AnchorTxResult.Retry("Couldn't reach Wrk. Check your connection and try again.")
            }
        }

    override suspend fun traces(episodeId: String): String? = withContext(Dispatchers.IO) {
        try {
            client.newCall(Request.Builder().url("$baseUrl/episodes/$episodeId/traces").build()).execute().use { r ->
                if (!r.isSuccessful) null else JSONObject(r.body!!.string()).getJSONArray("traces").toString()
            }
        } catch (e: Exception) { null }
    }

    override suspend fun uploadPredictions(episodeId: String, json: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url("$baseUrl/episodes/$episodeId/predictions")
                .post(json.toRequestBody("application/json".toMediaType())).build()
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (e: Exception) { false }
    }

    private fun strings(a: org.json.JSONArray?) = a?.let { List(it.length()) { i -> it.getString(i) } } ?: emptyList()

    private fun dbl(o: JSONObject, k: String): Double? = if (!o.has(k) || o.isNull(k)) null else o.getDouble(k)

    private fun parse(o: JSONObject): EpisodeView {
        val pay = o.optJSONObject("payment")
        return EpisodeView(
            status = o.optString("status", "scoring"),
            accepted = if (o.isNull("accepted")) null else o.optBoolean("accepted"),
            reasons = strings(o.optJSONArray("reasons")),
            paymentSignature = pay?.optString("signature")?.takeIf { it.isNotBlank() },
            paidUsd = pay?.optDouble("amount_usdc"),
            paymentError = o.optString("payment_error").takeIf { it.isNotBlank() && it != "null" },
            scoringError = o.optString("scoring_error").takeIf { it.isNotBlank() && it != "null" },
            framing = dbl(o, "framing"), plausibility = dbl(o, "plausibility"),
            handsVisiblePercent = dbl(o, "hands_visible_percent"), motionCorr = dbl(o, "flow_gyro_corr"),
            validatorScore = dbl(o, "validator_score"),
            duplicateOf = o.optJSONObject("checks")?.let { c -> if (c.isNull("duplicate_of")) null else c.optString("duplicate_of") },
            manifestIntact = o.optJSONObject("checks")?.optBoolean("manifest_intact"),
            streamsIntact = o.optJSONObject("checks")?.optBoolean("streams_intact"),
            trustLevel = o.optString("trust_level").takeIf { it.isNotBlank() && it != "null" },
            sybilScore = if (o.isNull("sybil_score") || !o.has("sybil_score")) null else o.optInt("sybil_score"),
            liveness = o.optJSONObject("liveness")?.let { LiveResult(it.optBoolean("passed"), it.optInt("matched"), it.optInt("total")) },
        )
    }
}
