package com.wrk.app.episode

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** What the live hand overlay cost while recording. Shown under technical details. */
data class OverlayStats(val detections: Int, val meanDetectMs: Double, val errors: Int, val lastError: String?) {
    fun toJson() = JSONObject().put("detections", detections).put("meanDetectMs", meanDetectMs).put("errors", errors).put("lastError", lastError ?: JSONObject.NULL)
    companion object {
        fun fromJson(o: JSONObject) = OverlayStats(o.getInt("detections"), o.getDouble("meanDetectMs"), o.getInt("errors"), if (o.isNull("lastError")) null else o.getString("lastError"))
    }
}

enum class EpisodeStatus { NotSubmitted, Submitted, Validating, InReview, Accepted, Paid, Rejected }

data class EpisodeState(
    val status: EpisodeStatus = EpisodeStatus.NotSubmitted,
    val bountyId: String,
    val bountyTitle: String,
    val perEpisodeUsd: Double,
    val createdAt: Long,
    /** "email" (Wrk anchors for them) or "wallet" (they approve the payout record on the phone). */
    val accountKind: String = "email",
    /** Wallet users sign the anchor on the phone; kept until the upload carries it. */
    val anchorSignature: String? = null,
    /** True while waiting for a connection or for the validator; the work is retried, nothing is lost. */
    val waiting: Boolean = false,
    val reasons: List<String> = emptyList(),
    val paidUsd: Double = 0.0,
    val paymentSignature: String? = null,
    /** The transaction that recorded the take on Solana, as reported by the validator. */
    val recordTx: String? = null,
    val error: String? = null,
    /** Everything below is what the validator measured, never what the phone claimed. */
    val framing: Double? = null,
    val plausibility: Double? = null,
    val handsVisiblePercent: Double? = null,
    val motionCorr: Double? = null,
    val validatorScore: Double? = null,
    val duplicateOf: String? = null,
    val manifestIntact: Boolean? = null,
    val streamsIntact: Boolean? = null,
    /** "attested" or "heuristic", as decided by the validator. */
    val trustLevel: String? = null,
    /** For tasks with a live check: movements that showed up, out of those asked. Null when the task has none. */
    /** The contributor's trust score (0 to 100) the last time the validator looked. */
    val sybilScore: Int? = null,
    val liveMatched: Int? = null,
    val liveTotal: Int? = null,
    val livePassed: Boolean? = null,
    /** Whether the live prediction strip has reached the server. */
    val predictionsSent: Boolean = false,
    /** Cost and health of the live hand overlay while recording. */
    val overlay: OverlayStats? = null,
) {
    val needsPayoutApproval: Boolean get() = accountKind == "wallet" && status == EpisodeStatus.NotSubmitted && anchorSignature == null

    fun toJson() = JSONObject()
        .put("status", status.name).put("bountyId", bountyId).put("bountyTitle", bountyTitle)
        .put("perEpisodeUsd", perEpisodeUsd).put("createdAt", createdAt).put("accountKind", accountKind)
        .put("anchorSignature", anchorSignature ?: JSONObject.NULL).put("waiting", waiting)
        .put("reasons", JSONArray(reasons)).put("paidUsd", paidUsd)
        .put("paymentSignature", paymentSignature ?: JSONObject.NULL).put("recordTx", recordTx ?: JSONObject.NULL).put("error", error ?: JSONObject.NULL)
        .put("framing", framing ?: JSONObject.NULL).put("plausibility", plausibility ?: JSONObject.NULL)
        .put("handsVisiblePercent", handsVisiblePercent ?: JSONObject.NULL).put("motionCorr", motionCorr ?: JSONObject.NULL)
        .put("validatorScore", validatorScore ?: JSONObject.NULL).put("duplicateOf", duplicateOf ?: JSONObject.NULL)
        .put("manifestIntact", manifestIntact ?: JSONObject.NULL).put("streamsIntact", streamsIntact ?: JSONObject.NULL)
        .put("trustLevel", trustLevel ?: JSONObject.NULL).put("sybilScore", sybilScore ?: JSONObject.NULL).put("liveMatched", liveMatched ?: JSONObject.NULL).put("liveTotal", liveTotal ?: JSONObject.NULL).put("livePassed", livePassed ?: JSONObject.NULL).put("predictionsSent", predictionsSent).put("overlay", overlay?.toJson() ?: JSONObject.NULL)

    companion object {
        fun fromJson(o: JSONObject) = EpisodeState(
            status = EpisodeStatus.valueOf(o.getString("status")),
            bountyId = o.getString("bountyId"), bountyTitle = o.getString("bountyTitle"),
            perEpisodeUsd = o.getDouble("perEpisodeUsd"), createdAt = o.getLong("createdAt"), accountKind = o.optString("accountKind", "email"),
            anchorSignature = o.optStringOrNull("anchorSignature"), waiting = o.optBoolean("waiting"),
            reasons = o.optJSONArray("reasons")?.let { a -> List(a.length()) { a.getString(it) } } ?: emptyList(),
            paidUsd = o.optDouble("paidUsd", 0.0), paymentSignature = o.optStringOrNull("paymentSignature"), recordTx = o.optStringOrNull("recordTx"),
            error = o.optStringOrNull("error"),
            framing = o.optDoubleOrNull("framing"), plausibility = o.optDoubleOrNull("plausibility"),
            handsVisiblePercent = o.optDoubleOrNull("handsVisiblePercent"), motionCorr = o.optDoubleOrNull("motionCorr"),
            validatorScore = o.optDoubleOrNull("validatorScore"), duplicateOf = o.optStringOrNull("duplicateOf"),
            manifestIntact = o.optBooleanOrNull("manifestIntact"), streamsIntact = o.optBooleanOrNull("streamsIntact"),
            trustLevel = o.optStringOrNull("trustLevel"), sybilScore = o.optIntOrNull("sybilScore"), liveMatched = o.optIntOrNull("liveMatched"), liveTotal = o.optIntOrNull("liveTotal"), livePassed = o.optBooleanOrNull("livePassed"), predictionsSent = o.optBoolean("predictionsSent"),
            overlay = if (o.isNull("overlay")) null else o.optJSONObject("overlay")?.let { OverlayStats.fromJson(it) },
        )
        private fun JSONObject.optStringOrNull(k: String) = if (!has(k) || isNull(k)) null else getString(k)
        private fun JSONObject.optDoubleOrNull(k: String) = if (!has(k) || isNull(k)) null else getDouble(k)
        private fun JSONObject.optIntOrNull(k: String) = if (!has(k) || isNull(k)) null else getInt(k)
        private fun JSONObject.optBooleanOrNull(k: String) = if (!has(k) || isNull(k)) null else getBoolean(k)
    }
}

data class StoredEpisode(val id: String, val dir: File, val state: EpisodeState)

/** Episodes live in their own folders so a killed app or a retried upload never loses a take. */
class EpisodeStore(private val root: File) {
    init { root.mkdirs() }

    fun dir(id: String) = File(root, id)

    fun begin(id: String): File = dir(id).also { it.mkdirs() }

    fun write(id: String, state: EpisodeState) {
        val tmp = File(dir(id), "state.json.tmp")
        tmp.writeText(state.toJson().toString())
        tmp.renameTo(File(dir(id), "state.json"))
    }

    fun state(id: String): EpisodeState? =
        File(dir(id), "state.json").takeIf { it.exists() }?.let { runCatching { EpisodeState.fromJson(JSONObject(it.readText())) }.getOrNull() }

    fun update(id: String, f: (EpisodeState) -> EpisodeState): EpisodeState {
        val next = f(state(id) ?: error("No such episode $id"))
        write(id, next)
        return next
    }

    fun manifest(id: String): JsonObj? =
        File(dir(id), "manifest.json").takeIf { it.exists() }?.let { parseJson(it.readText()) as JsonObj }

    fun list(): List<StoredEpisode> =
        (root.listFiles() ?: emptyArray()).filter { it.isDirectory }
            .mapNotNull { d -> state(d.name)?.let { StoredEpisode(d.name, d, it) } }
            .sortedByDescending { it.state.createdAt }

    /** Rejected captures can be deleted; nothing leaves the phone for them again. */
    fun delete(id: String) { dir(id).deleteRecursively() }

    /** Takes that were recorded but never reviewed leave a video behind; clear those once they are clearly abandoned. */
    fun pruneOrphans(olderThanMs: Long = 6 * 3_600_000L, now: Long = System.currentTimeMillis()) {
        (root.listFiles() ?: return).filter { it.isDirectory && !File(it, "state.json").exists() && now - it.lastModified() > olderThanMs }
            .forEach { it.deleteRecursively() }
    }

    val earnedUsd: Double get() = list().filter { it.state.status == EpisodeStatus.Paid }.sumOf { it.state.paidUsd }
}
