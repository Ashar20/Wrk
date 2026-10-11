package com.wrk.app.roles

import org.json.JSONObject

/** One take waiting for a person, with the automatic checks' numbers. Fractions are 0–1; hands-in-view is a percentage. */
data class ReviewItem(
    val episodeId: String,
    val bountyTitle: String,
    val taskSpec: String,
    val durationS: Double,
    val plausibility: Double?,
    val framing: Double?,
    val handsVisiblePercent: Double?,
    val motionCorr: Double?,
    val perEpisodeUsd: Double,
    val feeUsd: Double,
    val trustLevel: String? = null,
)

data class ReviewHistoryItem(val episodeId: String, val bountyTitle: String, val approved: Boolean, val decidedAt: Long, val feeUsd: Double, val feeSignature: String? = null)
data class ReviewHistory(val earnedUsd: Double, val items: List<ReviewHistoryItem>)

private fun JSONObject.dbl(k: String): Double? = if (!has(k) || isNull(k)) null else getDouble(k)

fun parseReviewItem(o: JSONObject) = ReviewItem(
    episodeId = o.getString("episode_id"), bountyTitle = o.getString("bounty_title"), taskSpec = o.optString("task_spec"),
    durationS = o.optDouble("duration_s", 0.0), plausibility = o.dbl("plausibility"), framing = o.dbl("framing"),
    handsVisiblePercent = o.dbl("hands_visible_percent"), motionCorr = o.dbl("flow_gyro_corr"),
    perEpisodeUsd = o.optDouble("per_episode_usdc", 0.0), feeUsd = o.optDouble("fee_usdc", 0.0),
    trustLevel = o.optString("trust_level").takeIf { it.isNotBlank() },
)

class ReviewApi(private val api: JsonApi) {
    suspend fun queue(): List<ReviewItem> {
        val a = api.get("/review/queue").getJSONArray("items")
        return List(a.length()) { parseReviewItem(a.getJSONObject(it)) }
    }

    suspend fun traces(id: String): String? = try { api.get("/review/$id/traces").getJSONArray("traces").toString() } catch (e: ApiException) { null }

    /** Returns the fee earned for this decision (0 if payouts are off). Throws ApiException if someone else decided first. */
    suspend fun decide(id: String, approve: Boolean, note: String): Double {
        val r = api.post("/review/$id/decision", JSONObject().put("decision", if (approve) "approve" else "reject").put("note", note))
        val fee = r.optJSONObject("fee")
        return if (fee != null && !fee.has("error")) fee.optDouble("amount_usdc", 0.0) else 0.0
    }

    suspend fun history(): ReviewHistory {
        val o = api.get("/review/mine")
        val a = o.getJSONArray("items")
        return ReviewHistory(o.optDouble("earned_usdc", 0.0), List(a.length()) {
            val i = a.getJSONObject(it)
            ReviewHistoryItem(i.getString("episode_id"), i.getString("bounty_title"), i.getString("decision") == "approved", i.optLong("decided_at"), i.optDouble("fee_usdc", 0.0), i.optString("fee_signature").takeIf { s -> s.isNotBlank() && s != "null" })
        })
    }

    fun videoUrl(id: String) = api.url("/review/$id/video")
    fun authHeader() = api.authHeader()
}
