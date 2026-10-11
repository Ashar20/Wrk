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
    /** Contributors must pass a live head-movement check / use a verified phone. */
    val liveCheck: Boolean = false,
    val verifiedOnly: Boolean = false,
    val accepted: Int,
    val rejected: Int,
    val inReview: Int,
    val scoring: Int,
    val spendUsd: Double,
    val avgPlausibility: Double?,
    /** Takes per score band: 0–20, 20–40, 40–60, 60–80, 80–100 %. */
    val histogram: List<Int>,
    /** Null when the validator isn't running a chain, so nothing is locked anywhere. */
    val escrow: EscrowStatus? = null,
)

/** What the task's on-chain vault holds. [lockedUsd] is null if the chain couldn't be read just now. */
data class EscrowStatus(val funded: Boolean, val lockedUsd: Double?, val deadline: Long, val canRefund: Boolean, val vault: String? = null)

data class BuyerSummary(val totalSpendUsd: Double, val bounties: List<BuyerBounty>)

fun parseBuyerSummary(o: JSONObject): BuyerSummary {
    val a = o.getJSONArray("bounties")
    return BuyerSummary(o.optDouble("total_spend_usdc", 0.0), List(a.length()) {
        val b = a.getJSONObject(it)
        val h = b.optJSONArray("histogram")
        BuyerBounty(
            id = b.getString("bounty_id"), title = b.getString("title"), open = b.optString("status") == "open",
            ownerIsYou = b.optBoolean("owner_is_you"), perEpisodeUsd = b.optDouble("per_episode_usdc"), minEpisodes = b.optInt("min_episodes"),
            budgetUsd = b.optDouble("budget_usdc"), humanReview = b.optString("review_policy") != "none",
            liveCheck = b.optString("liveness") == "require", verifiedOnly = b.optString("min_trust_level") == "attested",
            accepted = b.optInt("accepted"), rejected = b.optInt("rejected"), inReview = b.optInt("in_review"), scoring = b.optInt("scoring"),
            spendUsd = b.optDouble("spend_usdc"), avgPlausibility = if (b.isNull("avg_plausibility")) null else b.optDouble("avg_plausibility"),
            histogram = List(5) { i -> h?.optInt(i) ?: 0 },
            escrow = b.optJSONObject("escrow")?.let { e ->
                EscrowStatus(e.optBoolean("funded"), if (e.isNull("locked_usdc")) null else e.optDouble("locked_usdc"), e.optLong("deadline"), e.optBoolean("can_refund"), e.optString("vault").takeIf { v -> v.isNotBlank() && v != "null" })
            },
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

data class CreatedTask(val id: String, val funded: Boolean, val tx: String?)
data class RefundResult(val tx: String?)

data class CurvePoint(val episodes: Int, val meanError: Double, val stdError: Double)
data class ContributorUtility(val episodes: Int, val share: Double)
data class ModelResults(
    val encoder: String, val parameters: Int, val trainEpisodes: Int, val heldoutEpisodes: Int,
    val baselineError: Double, val modelError: Double, val curve: List<CurvePoint>, val utility: List<ContributorUtility>, val notes: List<String>,
) {
    /** Positive when the model beats "nothing changes"; negative when it doesn't yet. */
    val improvement: Double get() = if (baselineError == 0.0) 0.0 else (baselineError - modelError) / baselineError
}

fun parseModelResults(o: JSONObject): ModelResults {
    val curve = o.getJSONArray("curve")
    val util = o.getJSONArray("utility")
    val notes = o.getJSONArray("notes")
    return ModelResults(
        o.getString("encoder"), o.getInt("parameters"), o.getInt("train_episodes"), o.getInt("heldout_episodes"),
        o.getDouble("baseline_error"), o.getDouble("model_error"),
        List(curve.length()) { curve.getJSONObject(it).let { c -> CurvePoint(c.getInt("episodes"), c.getDouble("mean_error"), c.getDouble("std_error")) } },
        List(util.length()) { util.getJSONObject(it).let { u -> ContributorUtility(u.getInt("episodes"), u.getDouble("share")) } },
        List(notes.length()) { notes.getString(it) },
    )
}

class BuyerApi(private val api: JsonApi) {
    suspend fun model(): ModelResults = parseModelResults(api.get("/model"))

    suspend fun summary(): BuyerSummary = parseBuyerSummary(api.get("/buyer/summary"))

    /**
     * Posts a task. Where the buyer's key is held by Wrk the funds are locked right away ([CreatedTask.tx] is null);
     * a buyer with their own wallet gets a transaction to sign, and the task opens once it lands.
     */
    suspend fun create(title: String, spec: String, perTakeUsd: Double, takes: Int, humanReview: Boolean, verifiedOnly: Boolean = false, liveCheck: Boolean = false): CreatedTask {
        val r = api.post(
            "/buyer/bounties",
            JSONObject().put("title", title).put("task_spec", spec).put("per_episode_usdc", perTakeUsd).put("min_episodes", takes)
                .put("review_policy", if (humanReview) "borderline" else "none")
                .put("min_trust_level", if (verifiedOnly) "attested" else "heuristic")
                .put("liveness", if (liveCheck) "require" else "off"),
        )
        val e = r.optJSONObject("escrow")
        return CreatedTask(r.getJSONObject("bounty").getString("bounty_id"), funded = e?.optBoolean("funded", true) ?: true, tx = e?.optString("tx")?.takeIf { it.isNotBlank() })
    }

    /** After the wallet sent the funding transaction: has the vault received the money yet? */
    suspend fun confirm(id: String): Boolean = api.post("/buyer/bounties/$id/confirm", JSONObject()).optBoolean("funded")

    /** A fresh funding transaction for a task that was posted but never finished funding. */
    suspend fun fundTx(id: String): String = api.post("/buyer/bounties/$id/fund-tx", JSONObject()).getString("tx")

    /** After the deadline: take back what's unspent. Wallet buyers get a transaction to sign; others are done. */
    suspend fun refund(id: String): RefundResult {
        val r = api.post("/buyer/bounties/$id/refund", JSONObject())
        return RefundResult(r.optString("tx").takeIf { it.isNotBlank() })
    }

    /** The accepted takes' provenance and scores as JSON text, ready to share. */
    suspend fun dataset(id: String): String = api.get("/buyer/bounties/$id/dataset").toString(2)
}
