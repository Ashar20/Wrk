package com.wrk.app.capture

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What the world model guessed next: the closest frame it had already seen this take. */
class PredictResult(val distance: Double, val warming: Boolean, val thumbSize: Int, val rgb: ByteArray)

/**
 * Talks to the validator's live model: a small square crop and the current motion in, a thumbnail out. Entirely
 * additive: any failure means "no guess shown", and recording carries on untouched.
 */
class PredictClient(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder().callTimeout(4, TimeUnit.SECONDS).build(),
) {
    /** The crop edge the model expects, or null when no model is available. */
    suspend fun cropSize(): Int? = withContext(Dispatchers.IO) {
        try {
            client.newCall(Request.Builder().url("$baseUrl/predict").build()).execute().use { r ->
                if (!r.isSuccessful) return@use null
                val o = JSONObject(r.body!!.string())
                if (o.optBoolean("available")) o.getInt("size") else null
            }
        } catch (e: IOException) { null } catch (e: Exception) { null }
    }

    /** [motion] is [ax, ay, az, rx, ry, rz], the order the model was trained on (gyro in deg/s). */
    suspend fun predict(session: String, rgb: ByteArray, motion: FloatArray): PredictResult? = withContext(Dispatchers.IO) {
        try {
            val q = listOf("ax", "ay", "az", "rx", "ry", "rz").zip(motion.toList()).joinToString("&") { (k, v) -> "$k=$v" }
            val req = Request.Builder().url("$baseUrl/predict?session=$session&$q")
                .post(rgb.toRequestBody("application/octet-stream".toMediaType())).build()
            client.newCall(req).execute().use { r ->
                if (!r.isSuccessful) return@use null
                val size = r.header("x-thumbnail-size")?.toIntOrNull() ?: return@use null
                val bytes = r.body!!.bytes()
                if (bytes.size != size * size * 3) return@use null
                PredictResult(r.header("x-distance")?.toDoubleOrNull() ?: 0.0, r.header("x-warming") == "true", size, bytes)
            }
        } catch (e: Exception) { null }
    }
}
