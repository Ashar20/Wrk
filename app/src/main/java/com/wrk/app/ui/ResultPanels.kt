package com.wrk.app.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wrk.app.design.PaperCard
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkType
import com.wrk.app.design.lift
import com.wrk.app.episode.EpisodeState
import com.wrk.app.episode.EpisodeStore
import com.wrk.app.episode.JsonNum
import com.wrk.app.episode.JsonObj
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale

/** Everything measured about a finished take, below the verdict. Every number here came from the validator. */
@Composable
fun ResultPanels(id: String, s: EpisodeState, store: EpisodeStore) {
    val dir = store.dir(id)
    val scored = s.manifestIntact != null
    Column(verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        if (scored) MetersCard(s)
        TracesCard(dir, s.manifestIntact)
        PredictionStripCard(dir)
        DetailsCard(s, store.manifest(id))
    }
}

// ---- Meters ------------------------------------------------------------------------------------------------------

internal fun meterTone(v: Double?): Color = when {
    v == null -> WrkColors.paperSunk
    v >= 0.7 -> WrkColors.mintInk
    v >= 0.4 -> WrkColors.butterInk
    else -> WrkColors.negative
}

internal fun framingHint(handsVisiblePercent: Double?) =
    if (handsVisiblePercent == 0.0) "The camera never saw your hands. Tilt the phone down."
    else "How much of the take had your hands where the task needs them."

internal fun motionHint(plausibility: Double?, motionCorr: Double?) = when {
    plausibility == null -> "You barely moved your head, so there was nothing to check against."
    motionCorr != null && motionCorr < 0.4 -> "Walking and looking around scores far higher than standing still."
    else -> "Whether what the camera saw matches how the phone moved."
}

internal fun liveHint(s: EpisodeState) = when {
    s.livePassed == true -> "The head movements we asked for showed up in both the video and your phone's motion."
    else -> "We asked for ${s.liveTotal} head movements and ${s.liveMatched ?: 0} showed up in both the video and your phone's motion. Do each one as soon as it appears."
}

internal fun framingHint(s: EpisodeState) = framingHint(s.handsVisiblePercent)
internal fun motionHint(s: EpisodeState) = motionHint(s.plausibility, s.motionCorr)

@Composable
private fun MetersCard(s: EpisodeState) {
    PaperCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Meter("Hands in view", s.framing, framingHint(s))
            Meter("Motion check", s.plausibility, motionHint(s))
            if (s.liveTotal != null && s.liveTotal > 0) Meter("Live check", (s.liveMatched ?: 0).toDouble() / s.liveTotal, liveHint(s))
        }
    }
}

/** Label and percentage on one baseline, an 8dp pill track, a plain-language hint. Fill tone is the verdict. */
@Composable
fun Meter(label: String, value: Double?, hint: String) {
    Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Bottom) {
            Text(label, style = WrkType.body.copy(fontWeight = FontWeight.Medium), color = WrkColors.foreground)
            Text(if (value == null) "—" else "${Math.round(value * 100)}%", style = WrkType.figureInline, color = WrkColors.muted)
        }
        Box(Modifier.padding(top = 8.dp).fillMaxWidth().height(8.dp).clip(RoundedCornerShape(50)).background(WrkColors.paperSunk)) {
            Box(
                Modifier.fillMaxHeight().fillMaxWidth(if (value == null) 1f else (value.toFloat()).coerceIn(0.04f, 1f))
                    .clip(RoundedCornerShape(50)).background(meterTone(value)),
            )
        }
        Text(hint, style = WrkType.label.copy(fontSize = 12.sp, lineHeight = 17.sp), color = WrkColors.subtle, modifier = Modifier.padding(top = 6.dp))
    }
}

// ---- Traces ------------------------------------------------------------------------------------------------------

class TracePoints(val flowYaw: List<Float>, val gyroYaw: List<Float>, val flowPitch: List<Float>, val gyroPitch: List<Float>) {
    val isEmpty get() = flowYaw.size < 2
}

internal fun parseTraces(json: String): TracePoints {
    val a = JSONArray(json)
    fun col(k: String) = List(a.length()) { a.getJSONObject(it).optDouble(k, 0.0).toFloat() }
    return TracePoints(col("flowYaw"), col("gyroYaw"), col("flowPitch"), col("gyroPitch"))
}

@Composable
private fun TracesCard(dir: File, scored: Boolean?) {
    val traces by produceState<TracePoints?>(null, dir, scored) {
        value = withContext(Dispatchers.IO) { File(dir, "traces.json").takeIf { it.exists() }?.let { runCatching { parseTraces(it.readText()) }.getOrNull() } }
    }
    val t = traces ?: return
    if (t.isEmpty) return
    TracesBlock(t)
}

/** The two traces, flow against gyroscope, for turning and tilting. Shared by the contributor's result and the verifier's review. */
@Composable
fun TracesBlock(t: TracePoints) {
    PaperCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("What the check saw", style = WrkType.body.copy(fontWeight = FontWeight.Medium), color = WrkColors.foreground)
            Text(
                "A real take makes the picture's movement and the phone's rotation follow each other. A replayed video doesn't.",
                style = WrkType.label.copy(fontSize = 12.sp, lineHeight = 17.sp), color = WrkColors.subtle,
            )
            TraceChart("Turning left and right", t.flowYaw, t.gyroYaw)
            TraceChart("Tilting up and down", t.flowPitch, t.gyroPitch)
        }
    }
}

@Composable
private fun TraceChart(label: String, flow: List<Float>, gyro: List<Float>) {
    Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = WrkType.label, color = WrkColors.subtle)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("optical flow", style = WrkType.label, color = WrkColors.mintInk)
                Text("gyroscope", style = WrkType.label, color = WrkColors.butterInk)
            }
        }
        Canvas(Modifier.padding(top = 4.dp).fillMaxWidth().height(88.dp).clip(RoundedCornerShape(WrkShape.inner)).background(WrkColors.paperSunk)) {
            val pad = 8.dp.toPx()
            drawLine(WrkColors.foreground.copy(alpha = 0.12f), Offset(0f, size.height / 2), Offset(size.width, size.height / 2), 1.dp.toPx())
            fun line(values: List<Float>, color: Color) {
                if (values.size < 2) return
                val step = size.width / (values.size - 1)
                val path = Path()
                values.forEachIndexed { i, v ->
                    val x = i * step
                    val y = size.height / 2 - v.coerceIn(-1f, 1f) * (size.height / 2 - pad)
                    if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                drawPath(path, color, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
            line(gyro, WrkColors.butterInk)
            line(flow, WrkColors.mintInk)
        }
    }
}

// ---- Prediction strip --------------------------------------------------------------------------------------------

private class Tile(val tMs: Double, val warming: Boolean, val bitmap: android.graphics.Bitmap)

@Composable
private fun PredictionStripCard(dir: File) {
    val tiles by produceState<List<Tile>>(emptyList(), dir) {
        value = withContext(Dispatchers.IO) {
            val f = File(dir, "predictions.json")
            if (!f.exists()) return@withContext emptyList()
            runCatching {
                val arr = JSONObject(f.readText()).getJSONArray("predictions")
                (0 until arr.length()).mapNotNull { i ->
                    val o = arr.getJSONObject(i)
                    val raw = Base64.decode(o.getString("thumbnail").substringAfter("base64,"), Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(raw, 0, raw.size)?.let { Tile(o.getDouble("t"), o.getBoolean("warming"), it) }
                }
            }.getOrDefault(emptyList())
        }
    }
    if (tiles.isEmpty()) return
    PaperCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("World model, live during this take", style = WrkType.body.copy(fontWeight = FontWeight.Medium), color = WrkColors.foreground)
            Text(
                "What the model guessed came next, moment to moment: of the frames it had already seen this take, the one closest to where your motion said you were heading.",
                style = WrkType.label.copy(fontSize = 12.sp, lineHeight = 17.sp), color = WrkColors.subtle,
            )
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                itemsIndexed(tiles) { _, t ->
                    Column(Modifier.clip(RoundedCornerShape(WrkShape.inner)).background(WrkColors.lilac).padding(4.dp)) {
                        Image(t.bitmap.asImageBitmap(), null, Modifier.size(64.dp).clip(RoundedCornerShape(10.dp)))
                        Text(
                            if (t.warming) "learning…" else String.format(Locale.US, "%.1fs", t.tMs / 1000),
                            style = WrkType.label.copy(fontSize = 9.sp), color = WrkColors.lilacInk,
                            modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

// ---- Technical details -------------------------------------------------------------------------------------------

private fun JsonObj.obj(k: String) = map[k] as? JsonObj
private fun JsonObj.num(k: String) = (map[k] as? JsonNum)?.value
private fun JsonObj.str(k: String) = (map[k] as? com.wrk.app.episode.JsonStr)?.value

@Composable
private fun DetailsCard(s: EpisodeState, manifest: JsonObj?) {
    var open by remember { mutableStateOf(false) }
    Column {
        Box(
            Modifier.fillMaxWidth().lift(RoundedCornerShape(50)).clip(RoundedCornerShape(50)).background(WrkColors.paper)
                .clickable(role = Role.Button) { open = !open }.padding(horizontal = 20.dp, vertical = 14.dp),
        ) { Text("Technical details", style = WrkType.body.copy(fontWeight = FontWeight.SemiBold), color = WrkColors.muted) }
        if (open) {
            val cap = manifest?.obj("capture")
            val v = cap?.obj("video")
            val imu = cap?.obj("imu")
            val nominal = v?.num("fps_nominal")
            val observed = v?.num("fps_observed")
            val throttled = observed != null && nominal != null && observed < nominal * 0.8
            val imuRate = imu?.num("rate_hz_observed")
            Column(Modifier.padding(top = 8.dp).fillMaxWidth().clip(RoundedCornerShape(WrkShape.card)).background(WrkColors.paper).padding(horizontal = 20.dp, vertical = 4.dp)) {
                manifest?.num("duration_s")?.let { Row("Duration", String.format(Locale.US, "%.2fs", it)) }
                if (v != null) Row("Resolution", "${v.num("width")?.toInt()}×${v.num("height")?.toInt()}")
                nominal?.let { Row("Frame rate", "${it.toInt()} nominal") }
                Row("Frame rate observed", observed?.let { String.format(Locale.US, "%.2f", it) } ?: "unknown", warn = throttled)
                v?.num("frame_count")?.let { Row("Frames", it.toLong().toString()) }
                v?.str("codec")?.let { Row("Container", it) }
                imuRate?.let { Row("Motion rate", String.format(Locale.US, "%.1f Hz", it), warn = it in 0.1..39.9) }
                imu?.num("samples")?.let { Row("Motion samples", it.toLong().toString()) }
                Row("Acceleration", "includes gravity")
                Row("Location", "not shared")
                Row("Measured skew", manifest?.obj("sync")?.num("measured_skew_ms")?.let { String.format(Locale.US, "%.1f ms", it) } ?: "unknown")
                manifest?.obj("streams")?.obj("rgb")?.num("bytes")?.let { Row("Video size", String.format(Locale.US, "%.2f MB", it / 1_000_000)) }
                Row("Platform", manifest?.obj("client")?.str("type") ?: "android_native")
                s.overlay?.let {
                    Row("Overlay detections", it.detections.toString())
                    Row("Overlay cost", String.format(Locale.US, "%.0f ms", it.meanDetectMs))
                    Row("Overlay errors", it.errors.toString(), warn = it.errors > 0)
                    it.lastError?.let { e -> Row("Last error", e, warn = true) }
                }
                if (s.manifestIntact != null) {
                    // Everything below was measured by the validator, not the phone.
                    Row("Manifest verified", if (s.manifestIntact) "yes" else "no")
                    Row("Streams verified", if (s.streamsIntact == true) "yes" else "no")
                    Row("Motion in the take", s.motionCorr?.let { "${Math.round(it * 100)}%" } ?: "—")
                    Row("Duplicate of", s.duplicateOf ?: "none", warn = s.duplicateOf != null)
                    Row("Validator score", s.validatorScore?.toString() ?: "—")
                }
                Row("Trust level", s.trustLevel ?: "heuristic", last = true)
            }
            Text(
                "Scored on the server from the bytes it received. These checks measure whether a capture is plausible, not whether the scene was real. Attested means the take was signed by a verified phone's secure hardware key; heuristic means it wasn't.",
                style = WrkType.label.copy(fontSize = 12.sp, lineHeight = 17.sp), color = WrkColors.subtle,
                modifier = Modifier.padding(start = 4.dp, end = 4.dp, top = 10.dp),
            )
        }
    }
}

@Composable
private fun Row(label: String, value: String, warn: Boolean = false, last: Boolean = false) {
    Column {
        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
            Text(label, style = WrkType.label.copy(fontSize = 12.sp), color = WrkColors.subtle, modifier = Modifier.weight(1f))
            Text(value, style = WrkType.data, color = if (warn) WrkColors.caution else WrkColors.muted)
        }
        if (!last) Box(Modifier.fillMaxWidth().height(1.dp).background(WrkColors.paperSunk))
    }
}
