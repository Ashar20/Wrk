package com.wrk.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

interface BountyRepository {
    suspend fun bounties(): List<Bounty>
}

/** Offline seed so the app is browsable before the validator is reachable. */
object StaticBountyRepository : BountyRepository {
    private val farFuture = 4_102_444_800L
    private fun b(id: String, title: String, spec: String, task: String, usd: Double) =
        Bounty(id, title, spec, task, listOf("rgb", "imu"), 8, 30, usd, farFuture)

    override suspend fun bounties() = listOf(
        b("bounty_004", "Cup pick-and-place, indoor", "Pick up a cup from a surface, move it, and place it down. First-person view.", "cup_pick_and_place", 0.60),
        b("bounty_005", "Open a door and walk through", "Open an interior door, walk through it and close it behind you. Keep your head turning naturally.", "door_walkthrough", 0.80),
        b("bounty_006", "Fold a towel", "Fold a towel in half twice on a table, looking down at your hands the whole time.", "towel_fold", 0.50),
    )
}

class ApiBountyRepository(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder().callTimeout(6, TimeUnit.SECONDS).build(),
    private val fallback: BountyRepository = StaticBountyRepository,
) : BountyRepository {
    override suspend fun bounties(): List<Bounty> = withContext(Dispatchers.IO) {
        try {
            client.newCall(Request.Builder().url("$baseUrl/bounties").build()).execute().use { r ->
                check(r.isSuccessful) { "HTTP ${r.code}" }
                val arr = JSONObject(r.body!!.string()).getJSONArray("bounties")
                List(arr.length()) { Bounty.fromJson(arr.getJSONObject(it)) }
            }
        } catch (e: Exception) {
            fallback.bounties()
        }
    }
}
