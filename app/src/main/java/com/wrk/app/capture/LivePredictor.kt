package com.wrk.app.capture

import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/** One step of the model's running guess, for display now and replay after the take. */
class Prediction(val tMs: Long, val distance: Double, val warming: Boolean, val bitmap: Bitmap)

/** Turns a returned thumbnail (packed RGB) into a bitmap. */
fun PredictResult.toBitmap(): Bitmap {
    val px = IntArray(thumbSize * thumbSize) { i ->
        (0xFF shl 24) or ((rgb[i * 3].toInt() and 0xFF) shl 16) or ((rgb[i * 3 + 1].toInt() and 0xFF) shl 8) or (rgb[i * 3 + 2].toInt() and 0xFF)
    }
    return Bitmap.createBitmap(px, thumbSize, thumbSize, Bitmap.Config.ARGB_8888)
}

/** Records the live guess during a take. Drops a frame when the previous request is still out. */
class LivePredictor(private val client: PredictClient, private val session: String) {
    private val busy = AtomicBoolean(false)
    private val log = ArrayList<Prediction>()
    private var startedAt = 0L

    fun start() { startedAt = SystemClock.elapsedRealtime(); synchronized(log) { log.clear() } }

    /** Called off the main thread. [deliver] is invoked off the main thread too. */
    suspend fun submit(rgb: ByteArray, motion: FloatArray, deliver: (Prediction) -> Unit) {
        if (!busy.compareAndSet(false, true)) return
        try {
            val r = client.predict(session, rgb, motion) ?: return
            val p = Prediction(SystemClock.elapsedRealtime() - startedAt, r.distance, r.warming, r.toBitmap())
            synchronized(log) { if (log.size < MAX_ENTRIES) log += p }
            deliver(p)
        } finally {
            busy.set(false)
        }
    }

    /** The body `POST /episodes/:id/predictions` expects. Written beside the take so it survives the app closing. */
    fun saveTo(file: File) {
        val entries = synchronized(log) { ArrayList(log) }
        if (entries.isEmpty()) return
        val arr = JSONArray()
        for (p in entries) {
            val png = ByteArrayOutputStream().also { p.bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            arr.put(JSONObject().put("t", p.tMs).put("distance", p.distance).put("warming", p.warming)
                .put("thumbnail", "data:image/png;base64," + Base64.encodeToString(png, Base64.NO_WRAP)))
        }
        file.writeText(JSONObject().put("predictions", arr).toString())
    }

    private companion object { const val MAX_ENTRIES = 120 }
}
