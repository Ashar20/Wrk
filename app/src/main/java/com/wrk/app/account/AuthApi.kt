package com.wrk.app.account

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A failure the contributor can read. */
class AuthException(message: String) : Exception(message)

class AuthApi(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS).build(),
) {
    suspend fun startEmail(email: String) {
        post("/auth/email/start", JSONObject().put("email", email))
    }

    suspend fun verifyEmail(email: String, code: String): Account.Email {
        val o = post("/auth/email/verify", JSONObject().put("email", email).put("code", code))
        return Account.Email(o.getString("email"), o.getString("address"), o.getString("token"))
    }

    /** A one-time message for the wallet to sign. */
    suspend fun walletChallenge(address: String): String =
        post("/auth/wallet/challenge", JSONObject().put("address", address)).getString("message")

    /** Trades the wallet's signature for a session. */
    suspend fun walletVerify(address: String, signature: ByteArray): String =
        post("/auth/wallet/verify", JSONObject().put("address", address).put("signature", android.util.Base64.encodeToString(signature, android.util.Base64.NO_WRAP)))
            .getString("token")

    private suspend fun post(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(baseUrl + path)
                .post(body.toString().toRequestBody("application/json".toMediaType())).build()
            client.newCall(req).execute().use { r ->
                val text = r.body?.string().orEmpty()
                val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
                if (!r.isSuccessful) throw AuthException(json.optString("error").ifBlank { "Something went wrong (${r.code}). Try again." })
                json
            }
        } catch (e: IOException) {
            throw AuthException("Can't reach Wrk. Check your connection and try again.")
        }
    }
}
