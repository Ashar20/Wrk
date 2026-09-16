package com.wrk.app.wallet

import com.solana.publickey.SolanaPublicKey
import com.solana.transaction.AccountMeta
import com.solana.transaction.Message
import com.solana.transaction.Transaction
import com.solana.transaction.TransactionInstruction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** The proof-of-submission a wallet user signs. Wording must match the validator's check exactly. */
object MemoTx {
    const val PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

    fun text(bountyId: String, episodeId: String, manifestHash: String) = "wrk:v1:$bountyId:$episodeId:$manifestHash"

    /** Unsigned legacy transaction: one memo instruction, signed and paid for by [signer]. */
    fun build(signer: String, recentBlockhash: String, memo: String): ByteArray {
        val me = SolanaPublicKey.from(signer)
        val ix = TransactionInstruction(SolanaPublicKey.from(PROGRAM), listOf(AccountMeta(me, true, false)), memo.toByteArray(Charsets.UTF_8))
        val message = Message.Builder().addInstruction(ix).setRecentBlockhash(recentBlockhash).build()
        return Transaction(message).serialize()
    }
}

class SolanaRpc(
    private val url: String,
    private val client: OkHttpClient = OkHttpClient(),
) {
    suspend fun latestBlockhash(): String = withContext(Dispatchers.IO) {
        val body = JSONObject().put("jsonrpc", "2.0").put("id", 1).put("method", "getLatestBlockhash")
            .put("params", org.json.JSONArray().put(JSONObject().put("commitment", "finalized"))).toString()
        client.newCall(Request.Builder().url(url).post(body.toRequestBody("application/json".toMediaType())).build()).execute().use { r ->
            check(r.isSuccessful) { "RPC ${r.code}" }
            JSONObject(r.body!!.string()).getJSONObject("result").getJSONObject("value").getString("blockhash")
        }
    }
}
