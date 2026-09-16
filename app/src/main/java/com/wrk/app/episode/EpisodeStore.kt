package com.wrk.app.episode

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

enum class EpisodeStatus { NotSubmitted, Submitted, Validating, Accepted, Paid, Rejected }

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
    val error: String? = null,
) {
    val needsPayoutApproval: Boolean get() = accountKind == "wallet" && status == EpisodeStatus.NotSubmitted && anchorSignature == null

    fun toJson() = JSONObject()
        .put("status", status.name).put("bountyId", bountyId).put("bountyTitle", bountyTitle)
        .put("perEpisodeUsd", perEpisodeUsd).put("createdAt", createdAt).put("accountKind", accountKind)
        .put("anchorSignature", anchorSignature ?: JSONObject.NULL).put("waiting", waiting)
        .put("reasons", JSONArray(reasons)).put("paidUsd", paidUsd)
        .put("paymentSignature", paymentSignature ?: JSONObject.NULL).put("error", error ?: JSONObject.NULL)

    companion object {
        fun fromJson(o: JSONObject) = EpisodeState(
            status = EpisodeStatus.valueOf(o.getString("status")),
            bountyId = o.getString("bountyId"), bountyTitle = o.getString("bountyTitle"),
            perEpisodeUsd = o.getDouble("perEpisodeUsd"), createdAt = o.getLong("createdAt"), accountKind = o.optString("accountKind", "email"),
            anchorSignature = o.optStringOrNull("anchorSignature"), waiting = o.optBoolean("waiting"),
            reasons = o.optJSONArray("reasons")?.let { a -> List(a.length()) { a.getString(it) } } ?: emptyList(),
            paidUsd = o.optDouble("paidUsd", 0.0), paymentSignature = o.optStringOrNull("paymentSignature"),
            error = o.optStringOrNull("error"),
        )
        private fun JSONObject.optStringOrNull(k: String) = if (isNull(k)) null else getString(k)
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
