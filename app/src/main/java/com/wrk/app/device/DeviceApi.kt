package com.wrk.app.device

import com.wrk.app.roles.ApiException
import com.wrk.app.roles.JsonApi
import org.json.JSONArray
import org.json.JSONObject

/** What the validator concluded about this phone. */
data class DeviceRegistration(val deviceId: String, val attested: Boolean, val hardwareLevel: String, val bootVerified: Boolean, val appVerified: Boolean)

/** The validator's side of phone verification. Needs no sign-in: it's about the phone, not the person. */
class DeviceApi(private val api: JsonApi) {
    /** A single-use challenge the new key must be created with, so an old registration can't be replayed. */
    suspend fun challenge(): String = api.get("/device/challenge").getString("challenge")

    /** Sends the key's certificate chain (leaf first, as base64 DER). Throws ApiException with the reasons if refused. */
    suspend fun register(challenge: String, chain: List<String>): DeviceRegistration {
        val r = api.post("/device/register", JSONObject().put("challenge", challenge).put("chain", JSONArray(chain)))
        return DeviceRegistration(
            deviceId = r.getString("device_id"), attested = r.optString("trust") == "attested", hardwareLevel = r.optString("level"),
            bootVerified = r.optBoolean("boot_verified"), appVerified = r.optBoolean("app_verified"),
        )
    }
}

class DeviceUnavailable(message: String) : Exception(message)
