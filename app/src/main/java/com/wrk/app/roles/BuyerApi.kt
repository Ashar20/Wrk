package com.wrk.app.roles

import org.json.JSONObject
import java.math.BigDecimal
import java.math.RoundingMode

data class BuyerBounty(
    val id: String,
    val title: String,
    val open: Boolean,
    val ownerIsYou: Boolean,
    val perEpisodeUsd: Double,
    val minEpisodes: Int,
    val budgetUsd: Double,
    val humanReview: Boolean,
    val accepted: Int,
    val rejected: Int,
    val inReview: Int,
    val scoring: Int,
    val spendUsd: Double,
    val avgPlausibility: Double?,
    /** Takes per score band: 0–20, 20–40, 40–60, 60–80, 80–100 %. */
    val histogram: List<Int>,
)

data class BuyerSummary(val totalSpendUsd: Double, val bounties: List<BuyerBounty>)

fun parseBuyerSummary(o: JSONObject): BuyerSummary {
    val a = o.getJSONArray("bounties")
    return BuyerSummary(o.optDouble("total_spend_usdc", 0.0), List(a.length()) {
        val b = a.getJSONObject(it)
        val h = b.optJSONArray("histogram")
        BuyerBounty(
            id = b.getString("bounty_id"), title = b.getString("title"), open = b.optString("status") == "open",
            ownerIsYou = b.optBoolean("owner_is_you"), perEpisodeUsd = b.optDouble("per_episode_usdc"), minEpisodes = b.optInt("min_episodes"),
            budgetUsd = b.optDouble("budget_usdc"), humanReview = b.optString("review_policy") == "borderline",
            accepted = b.optInt("accepted"), rejected = b.optInt("rejected"), inReview = b.optInt("in_review"), scoring = b.optInt("scoring"),
            spendUsd = b.optDouble("spend_usdc"), avgPlausibility = if (b.isNull("avg_plausibility")) null else b.optDouble("avg_plausibility"),
            histogram = List(5) { i -> h?.optInt(i) ?: 0 },
        )
    })
}

/** The money for a task, split the way the spec asks: 60% takes, 30% utility pool, 5% validators, 5% treasury. */
data class Budget(val totalUsd: Double, val takesUsd: Double, val utilityUsd: Double, val validatorsUsd: Double, val treasuryUsd: Double)

private fun cents(v: Double) = BigDecimal(v).setScale(2, RoundingMode.HALF_UP).toDouble()

/** Mirrors the validator's budget maths exactly so the form shows what the server will charge. */
fun budgetFor(perTakeUsd: Double, takes: Int): Budget {
    val takesUsd = cents(perTakeUsd * takes)
    val total = cents(takesUsd / 0.6)
    val utility = cents(total * 0.3)
    val validators = cents(total * 0.05)
    return Budget(total, takesUsd, utility, validators, cents(total - takesUsd - utility - validators))
}

class BuyerApi(private val api: JsonApi) {
    suspend fun summary(): BuyerSummary = parseBuyerSummary(api.get("/buyer/summary"))

    suspend fun create(title: String, spec: String, perTakeUsd: Double, takes: Int, humanReview: Boolean): String =
        api.post(
            "/buyer/bounties",
            JSONObject().put("title", title).put("task_spec", spec).put("per_episode_usdc", perTakeUsd).put("min_episodes", takes)
                .put("review_policy", if (humanReview) "borderline" else "none"),
        ).getJSONObject("bounty").getString("bounty_id")

    /** The accepted takes' provenance and scores as JSON text, ready to share. */
    suspend fun dataset(id: String): String = api.get("/buyer/bounties/$id/dataset").toString(2)
}
