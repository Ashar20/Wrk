package com.wrk.app.location

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import com.wrk.app.roles.JsonApi
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import kotlin.coroutines.resume

/**
 * Roughly where a take was made: an area of about a kilometre, never a precise point. Rounded here, on the phone, before
 * anything is sent. The validator uses it only to notice many brand-new accounts in one small place.
 */
data class CoarseLocation(val lat: Double, val lon: Double, val mock: Boolean) {
    fun toJson(): JSONObject = JSONObject().put("lat", lat).put("lon", lon).put("grid_km", GRID_KM).put("mock", mock)

    companion object {
        const val GRID_KM = 1.1

        /** To the nearest 0.01 degrees (about 1.1 km north-south): the corner of a cell, not where the person is standing. */
        fun toGrid(v: Double): Double = Math.round(v * 100.0) / 100.0

        fun of(lat: Double, lon: Double, mock: Boolean) = CoarseLocation(toGrid(lat), toGrid(lon), mock)
    }
}

/** What the validator needs before a take is recorded. */
data class Policy(val deviceRequired: Boolean, val locationRequired: Boolean)

class PolicyApi(private val api: JsonApi) {
    /** Null when the validator can't be reached; callers then carry on and let the validator decide at upload. */
    suspend fun get(): Policy? = try {
        api.get("/policy").let { Policy(it.optBoolean("device_required"), it.optBoolean("location_required")) }
    } catch (e: Exception) { null }
}

/** One approximate location fix, preferring a recent one the phone already has. */
class LocationFinder(private val context: Context) {
    private val lm get() = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    @SuppressLint("MissingPermission") // callers check ACCESS_COARSE_LOCATION first
    suspend fun current(): CoarseLocation? {
        val providers = listOf(LocationManager.NETWORK_PROVIDER, "fused", LocationManager.PASSIVE_PROVIDER, LocationManager.GPS_PROVIDER)
        val now = System.currentTimeMillis()
        val recent = providers.mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
            .filter { now - it.time < 10 * 60_000 }.maxByOrNull { it.time }
        recent?.let { return it.coarse() }

        // Nothing recent: ask for one fix, and give up quickly rather than hold up recording.
        return withTimeoutOrNull(8_000) {
            suspendCancellableCoroutine { cont ->
                val signal = CancellationSignal().also { s -> cont.invokeOnCancellation { s.cancel() } }
                val provider = providers.firstOrNull { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) && it != LocationManager.PASSIVE_PROVIDER }
                if (provider == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) { cont.resume(null); return@suspendCancellableCoroutine }
                runCatching {
                    lm.getCurrentLocation(provider, signal, context.mainExecutor) { loc -> cont.resume(loc?.coarse()) }
                }.onFailure { cont.resume(null) }
            }
        }
    }

    private fun Location.coarse(): CoarseLocation {
        val mock = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) isMock else @Suppress("DEPRECATION") isFromMockProvider
        return CoarseLocation.of(latitude, longitude, mock)
    }
}
