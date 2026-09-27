package com.wrk.app.roles

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A failure the person can read and act on. [status] is the HTTP code, or 0 when the server couldn't be reached. */
class ApiException(message: String, val status: Int = 0) : Exception(message) {
    val signedOut get() = status == 401
}

/** Small authenticated JSON client for the verifier and buyer endpoints. */
class JsonApi(
    private val baseUrl: String,
    private val token: () -> String?,
    private val client: OkHttpClient = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build(),
) {
    suspend fun get(path: String): JSONObject = call(path, null)
    suspend fun post(path: String, body: JSONObject): JSONObject = call(path, body)

    fun authHeader(): Map<String, String> = token()?.let { mapOf("Authorization" to "Bearer $it") } ?: emptyMap()
    fun url(path: String) = baseUrl + path

    private suspend fun call(path: String, body: JSONObject?): JSONObject = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(baseUrl + path).apply {
            token()?.let { header("Authorization", "Bearer $it") }
            if (body != null) post(body.toString().toRequestBody("application/json".toMediaType()))
        }.build()
        try {
            client.newCall(req).execute().use { r ->
                val text = r.body?.string().orEmpty()
                val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
                if (!r.isSuccessful) {
                    throw ApiException(
                        json.optString("error").ifBlank { if (r.code == 401) "Sign in again to continue." else "Something went wrong (${r.code}). Try again." },
                        r.code,
                    )
                }
                json
            }
        } catch (e: IOException) {
            throw ApiException("Can't reach Wrk. Check your connection and try again.")
        }
    }
}
