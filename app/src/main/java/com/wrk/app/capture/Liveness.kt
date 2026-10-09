package com.wrk.app.capture

import com.wrk.app.roles.JsonApi
import org.json.JSONArray
import org.json.JSONObject

enum class Axis(val wire: String) {
    /** Turning the head left and right. */
    Yaw("yaw"),
    /** Nodding up and down. */
    Pitch("pitch");

    companion object { fun fromWire(s: String) = entries.first { it.wire == s } }
}

/** One head movement the validator asked for, [atMs] after recording started. */
data class Prompt(val atMs: Long, val axis: Axis) {
    val text get() = when (axis) { Axis.Yaw -> "Turn your head left, then right"; Axis.Pitch -> "Nod your head up, then down" }
}

data class LivenessChallenge(val nonce: String, val prompts: List<Prompt>)

/** What the take reports back: the challenge it answered and the prompts it actually showed. */
data class LivenessClaim(val nonce: String, val shown: List<Prompt>) {
    fun toJson(): JSONObject = JSONObject().put("nonce", nonce).put(
        "prompts", JSONArray(shown.map { JSONObject().put("at_ms", it.atMs).put("axis", it.axis.wire) }),
    )
}

/** When prompts show, and when a take that has to answer them may end. Pure so it can be tested without a phone. */
object LivenessSchedule {
    /** How long a prompt stays on screen, and the time a person has to do the movement. */
    const val SHOW_MS = 3_000L
    const val MIN_PROMPTS = 2

    /** The prompt on screen right now, if any. */
    fun current(prompts: List<Prompt>, elapsedMs: Long): Prompt? =
        prompts.lastOrNull { it.atMs <= elapsedMs && elapsedMs < it.atMs + SHOW_MS }

    /** How many prompts have appeared so far. */
    fun shownCount(prompts: List<Prompt>, elapsedMs: Long) = prompts.count { it.atMs <= elapsedMs }

    /**
     * A take can end once it has at least two prompts and the last one that appeared has had its full time, and not before
     * the task's minimum length. A prompt that appears later has to be finished too.
     */
    fun canStop(prompts: List<Prompt>, elapsedMs: Long, minMs: Long): Boolean {
        val shown = prompts.filter { it.atMs <= elapsedMs }
        return shown.size >= MIN_PROMPTS && elapsedMs >= maxOf(minMs, shown.last().atMs + SHOW_MS)
    }

    /** The prompts to report: those whose full time fit inside a take of [durationMs]. */
    fun claimed(prompts: List<Prompt>, durationMs: Long): List<Prompt> = prompts.takeWhile { it.atMs + SHOW_MS <= durationMs }
}

/** Asks the validator for a fresh random sequence for one take. No sign-in needed. */
class LivenessApi(private val api: JsonApi) {
    suspend fun challenge(): LivenessChallenge {
        val o = api.get("/liveness/challenge")
        val a = o.getJSONArray("prompts")
        return LivenessChallenge(o.getString("nonce"), List(a.length()) {
            val p = a.getJSONObject(it)
            Prompt(p.getLong("at_ms"), Axis.fromWire(p.getString("axis")))
        })
    }
}
