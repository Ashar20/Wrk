package com.wrk.app.trust

import com.wrk.app.roles.JsonApi
import org.json.JSONObject

/** One thing that adds to or takes from a trust score. [max] is the most it can add; 0 for deductions. */
data class TrustFactor(val id: String, val label: String, val points: Int, val max: Int, val note: String?)

/** How much the validator trusts an account, 0 to 100, and what that score is made of. */
data class TrustReport(
    val score: Int,
    /** "new", "building" or "trusted". */
    val tier: String,
    val factors: List<TrustFactor>,
    /** Takes allowed per day, and how many were used today. */
    val cap: Int,
    val used: Int,
    val liveVerifiedUntil: Long?,
)

fun parseTrust(o: JSONObject): TrustReport {
    val a = o.getJSONArray("factors")
    return TrustReport(
        score = o.getInt("score"), tier = o.optString("tier", "new"),
        factors = List(a.length()) {
            val f = a.getJSONObject(it)
            TrustFactor(f.getString("id"), f.getString("label"), f.getInt("points"), f.optInt("max"), if (f.isNull("note")) null else f.optString("note").takeIf { n -> n.isNotBlank() })
        },
        cap = o.optInt("cap"), used = o.optInt("used"),
        liveVerifiedUntil = if (o.isNull("live_verified_until")) null else o.optLong("live_verified_until"),
    )
}

class TrustApi(private val api: JsonApi) {
    /** Null when it can't be fetched right now (offline, or the validator has trust scores off). */
    suspend fun get(address: String): TrustReport? = try { parseTrust(api.get("/trust/$address")) } catch (e: Exception) { null }
}

/** What the validator concluded from a standalone live check. */
sealed interface LiveVerify {
    data class Done(val passed: Boolean, val matched: Int, val total: Int, val trust: TrustReport?) : LiveVerify
    data class Refused(val message: String) : LiveVerify
    data class Retry(val message: String) : LiveVerify
}
