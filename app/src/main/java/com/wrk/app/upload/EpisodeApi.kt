package com.wrk.app.upload

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
)

sealed interface UploadResult {
    data class Ok(val view: EpisodeView) : UploadResult
    /** Offline, timeout or a server hiccup: keep the take and try again. */
    data class Retry(val why: String) : UploadResult
    /** The validator refused the bytes; trying again will not change that. */
    data class Refused(val reasons: List<String>) : UploadResult
    data object SignInExpired : UploadResult
}

interface EpisodeApi {
    suspend fun upload(manifestJson: String, rgb: File, imu: File, anchorSignature: String?, bearer: String?): UploadResult
    /** Null when the validator can't be reached right now. */
    suspend fun fetch(episodeId: String): EpisodeView?
    /** The aligned flow/gyro traces as JSON text, or null when unavailable. */
    suspend fun traces(episodeId: String): String? = null
    /** Sends the saved live-prediction strip. Returns true once the server has it. */
    suspend fun uploadPredictions(episodeId: String, json: String): Boolean = true
}

class HttpEpisodeApi(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(5, TimeUnit.MINUTES).writeTimeout(2, TimeUnit.MINUTES).readTimeout(60, TimeUnit.SECONDS).build(),
) : EpisodeApi {

    override suspend fun upload(manifestJson: String, rgb: File, imu: File, anchorSignature: String?, bearer: String?): UploadResult =
        withContext(Dispatchers.IO) {
            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("manifest", manifestJson)
                .apply { if (anchorSignature != null) addFormDataPart("anchor_signature", anchorSignature) }
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
        )
    }
}
