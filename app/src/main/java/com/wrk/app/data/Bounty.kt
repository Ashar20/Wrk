package com.wrk.app.data

import org.json.JSONObject

data class Bounty(
    val id: String,
    val title: String,
    val taskSpec: String,
    val task: String,
    val requiredModalities: List<String>,
    val minDurationS: Int,
    val maxDurationS: Int,
    val perEpisodeUsd: Double,
    val deadline: Long,
    /** The contributor is prompted for head movements, and the take must show them. */
    val liveCheck: Boolean = false,
) {
    companion object {
        fun fromJson(o: JSONObject): Bounty {
            val range = o.getJSONArray("duration_range_s")
            val mods = o.getJSONArray("required_modalities")
            return Bounty(
                id = o.getString("bounty_id"),
                title = o.getString("title"),
                taskSpec = o.getString("task_spec"),
                task = o.getString("task"),
                requiredModalities = List(mods.length()) { mods.getString(it) },
                minDurationS = range.getInt(0),
                maxDurationS = range.getInt(1),
                perEpisodeUsd = o.getDouble("per_episode_usdc"),
                deadline = o.getLong("deadline"),
                liveCheck = o.optString("liveness") == "require",
            )
        }
    }
}
