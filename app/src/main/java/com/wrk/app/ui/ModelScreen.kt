package com.wrk.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.wrk.app.design.FieldCard
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkType
import com.wrk.app.roles.BuyerApi
import com.wrk.app.roles.CurvePoint
import com.wrk.app.roles.ModelResults
import java.util.Locale

/** What the collected takes are worth to a world model: error against number of takes, and who contributed what. */
@Composable
fun ModelScreen(api: BuyerApi, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val state by produceState<Result<ModelResults>?>(null) { value = runCatching { api.model() } }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        PaperButton("Back", onBack)
        Text("What the data is worth", style = WrkType.title, color = WrkColors.foreground, modifier = Modifier.padding(top = 8.dp))
        val m = state?.getOrNull()
        if (m == null) {
            Text(if (state?.isFailure == true) "Couldn't load the results." else "Loading\u2026", style = WrkType.body, color = WrkColors.muted)
            return@Column
        }
        PaperCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Tag("Prediction error as takes grow")
                Text("Lower is better. Each point averages three runs; the bar is the spread.", style = WrkType.body, color = WrkColors.muted)
                CurveChart(m.curve, Modifier.fillMaxWidth().height(180.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    m.curve.firstOrNull()?.let { Text("${it.episodes} take${if (it.episodes == 1) "" else "s"}", style = WrkType.data, color = WrkColors.subtle) }
                    m.curve.lastOrNull()?.let { Text("${it.episodes} takes", style = WrkType.data, color = WrkColors.subtle) }
                }
            }
        }
        val beats = m.improvement > 0
        FieldCard(if (beats) WrkColors.mint else WrkColors.butter, Modifier.fillMaxWidth()) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Tag("On takes it never saw", color = if (beats) WrkColors.mintInk else WrkColors.butterInk)
                Text(
                    "${pct(m.modelError)} error against ${pct(m.baselineError)} for guessing nothing changes " +
                        if (beats) "(${pct(m.improvement)} better)." else "(not better yet).",
                    style = WrkType.body, color = if (beats) WrkColors.mintInk else WrkColors.butterInk,
                )
            }
        }
        if (m.utility.isNotEmpty()) PaperCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Tag("Each contributor's share of the improvement")
                m.utility.forEachIndexed { i, u ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Contributor ${i + 1} \u00b7 ${u.episodes} take${if (u.episodes == 1) "" else "s"}", style = WrkType.body, color = WrkColors.foreground)
                        Text(pct(u.share), style = WrkType.data, color = WrkColors.foreground)
                    }
                }
                Text("Measured by leaving each contributor out and seeing how much worse the model gets.", style = WrkType.body, color = WrkColors.muted)
            }
        }
        m.notes.forEach { Text(it, style = WrkType.body, color = WrkColors.muted) }
        Text("${m.encoder}, ${m.parameters / 1000}k trained parameters, trained on ${m.trainEpisodes} takes and tested on ${m.heldoutEpisodes}.", style = WrkType.data, color = WrkColors.subtle)
    }
}

private fun pct(v: Double) = String.format(Locale.US, "%.0f%%", v * 100)

@Composable
private fun CurveChart(points: List<CurvePoint>, modifier: Modifier = Modifier) {
    if (points.size < 2) return
    Canvas(modifier) {
        val top = points.maxOf { it.meanError + it.stdError }
        val bottom = 0.0
        val xMax = points.maxOf { it.episodes }.toFloat()
        val xMin = points.minOf { it.episodes }.toFloat()
        fun x(e: Int) = if (xMax == xMin) 0f else (e - xMin) / (xMax - xMin) * size.width
        fun y(v: Double) = size.height - ((v - bottom) / (top - bottom)).toFloat() * size.height
        val line = Path().apply { points.forEachIndexed { i, p -> if (i == 0) moveTo(x(p.episodes), y(p.meanError)) else lineTo(x(p.episodes), y(p.meanError)) } }
        drawPath(line, WrkColors.ink, style = Stroke(width = 4f))
        points.forEach { p ->
            drawLine(WrkColors.subtle, Offset(x(p.episodes), y(p.meanError + p.stdError)), Offset(x(p.episodes), y(p.meanError - p.stdError)), strokeWidth = 3f)
            drawCircle(WrkColors.ink, 9f, Offset(x(p.episodes), y(p.meanError)))
            drawCircle(Color.White, 4f, Offset(x(p.episodes), y(p.meanError)))
        }
    }
}
