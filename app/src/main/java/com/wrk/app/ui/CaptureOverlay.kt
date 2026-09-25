package com.wrk.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wrk.app.capture.GuideRegion
import com.wrk.app.capture.HandFrame
import com.wrk.app.capture.HandSkeleton
import com.wrk.app.capture.Prediction
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkType
import com.wrk.app.design.lift
import kotlin.math.max
import kotlin.math.min

private val Bone = Color(56, 189, 248, (0.9f * 255).toInt())
private val Joint = Color(255, 255, 255, (0.85f * 255).toInt())
private val Pivot = Color(0xFFF97316)
private val GuideSeen = Color(199, 230, 218, (0.85f * 255).toInt()) // mint: framing is right
private val GuideMissing = Color(246, 220, 171, (0.9f * 255).toInt()) // butter: needs a hand

/**
 * Skeleton and guide box over the live viewfinder. The preview fills its view by centre-crop, so frame coordinates
 * are mapped through the same crop; the guide is the box the validator scores framing against.
 */
@Composable
fun HandOverlay(frame: HandFrame?, showGuide: Boolean, modifier: Modifier = Modifier) {
    Canvas(modifier.fillMaxSize()) {
        val fw = frame?.width?.toFloat() ?: 9f
        val fh = frame?.height?.toFloat() ?: 16f
        val scale = max(size.width / fw, size.height / fh)
        val ox = (size.width - fw * scale) / 2f
        val oy = (size.height - fh * scale) / 2f
        fun x(n: Float) = ox + n * fw * scale
        fun y(n: Float) = oy + n * fh * scale

        if (showGuide) {
            val seen = frame?.hands?.isNotEmpty() == true
            drawRoundRect(
                color = if (seen) GuideSeen else GuideMissing,
                topLeft = Offset(x(GuideRegion.X0), y(GuideRegion.Y0)),
                size = Size(x(GuideRegion.X1) - x(GuideRegion.X0), y(GuideRegion.Y1) - y(GuideRegion.Y0)),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(12.dp.toPx()),
                style = Stroke(2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx()))),
            )
        }
        frame?.hands?.forEach { hand -> drawHand(hand.map { Offset(x(it.x), y(it.y)) }) }
    }
}

private fun DrawScope.drawHand(p: List<Offset>) {
    if (p.size < 21) return
    val unit = min(size.width, size.height)
    for ((a, b) in HandSkeleton.connections) drawLine(Bone, p[a], p[b], strokeWidth = 0.006f * unit * 1.6f, cap = StrokeCap.Round)
    for (pt in p) drawCircle(Joint, radius = 0.007f * unit * 1.6f, center = pt)
    for (i in HandSkeleton.pivots) drawCircle(Pivot, radius = 0.013f * unit * 1.6f, center = p[i])
}

/** The model's current guess, floating over the video. Lilac: this is machine judgement, not money. */
@Composable
fun PredictionBubble(prediction: Prediction?, modifier: Modifier = Modifier) {
    if (prediction == null) return
    val shape = RoundedCornerShape(16.dp)
    Column(modifier.lift(shape).clip(shape).background(WrkColors.lilac).padding(6.dp)) {
        Image(
            prediction.bitmap.asImageBitmap(), contentDescription = null, filterQuality = FilterQuality.Medium,
            modifier = Modifier.size(84.dp).clip(RoundedCornerShape(11.dp)),
        )
        Spacer(Modifier.height(3.dp))
        Text(
            if (prediction.warming) "learning your take…" else "model's guess",
            style = WrkType.label.copy(fontSize = 10.sp), color = WrkColors.lilacInk,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
    }
}
