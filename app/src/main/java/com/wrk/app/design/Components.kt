package com.wrk.app.design

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.em
import androidx.compose.foundation.Canvas
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import java.util.Locale

private val Pill = RoundedCornerShape(percent = 50)

/** DESIGN.md's single paper-on-bone lift. The only shadow in the app. */
fun Modifier.lift(shape: androidx.compose.ui.graphics.Shape) =
    shadow(10.dp, shape, ambientColor = Color(0x14131315), spotColor = Color(0x38131315))

private fun Modifier.tappable(onClick: (() -> Unit)?, role: Role = Role.Button) =
    if (onClick == null) this else clickable(role = role, onClick = onClick)

/** A 30dp region. Mint = the task / money you can act on, lilac = the model's reading, butter = needs a hand. */
@Composable
fun Panel(
    color: Color,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(WrkShape.panel)
    Box(modifier.clip(shape).background(color).tappable(onClick).padding(horizontal = 20.dp, vertical = 28.dp)) { content() }
}

@Composable
fun PaperCard(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(WrkShape.card)
    Box(modifier.lift(shape).clip(shape).background(WrkColors.paper).tappable(onClick).padding(horizontal = 16.dp, vertical = 14.dp)) { content() }
}

/** Reserved for money that has settled and for on-chain receipts. */
@Composable
fun InkCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(WrkShape.card)
    Box(modifier.clip(shape).background(WrkColors.ink).padding(horizontal = 20.dp, vertical = 16.dp)) { content() }
}

@Composable
fun FieldCard(bg: Color, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(WrkShape.card)
    Box(modifier.clip(shape).background(bg).tappable(onClick).padding(horizontal = 16.dp, vertical = 14.dp)) { content() }
}

@Composable
fun Chip(text: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.clip(Pill)
            .background(if (selected) WrkColors.lilac else WrkColors.paper)
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(
            text,
            style = WrkType.body.copy(fontWeight = if (selected) androidx.compose.ui.text.font.FontWeight.SemiBold else androidx.compose.ui.text.font.FontWeight.Normal),
            color = if (selected) WrkColors.lilacInk else WrkColors.muted,
        )
    }
}

@Composable
fun Tag(text: String, color: Color = WrkColors.muted, modifier: Modifier = Modifier) =
    Text(text, style = WrkType.label, color = color, modifier = modifier)

/**
 * A quoted dollar amount: one weight, tabular, the unit riding the baseline.
 * Cents drop to 62% opacity only on the bone ground (`knockDownCents`); on mint/lilac/butter they stay solid.
 */
@Composable
fun Figure(
    usd: Double,
    style: androidx.compose.ui.text.TextStyle = WrkType.figureHero,
    color: Color = WrkColors.foreground,
    knockDownCents: Boolean = false,
    unit: String? = null,
    modifier: Modifier = Modifier,
) {
    val whole = String.format(Locale.US, "%.2f", usd)
    val (dollars, cents) = whole.substringBefore('.') to whole.substringAfter('.')
    Text(
        buildAnnotatedString {
            append("$$dollars")
            withStyle(SpanStyle(color = if (knockDownCents) color.copy(alpha = 0.62f) else color)) { append(".$cents") }
            if (unit != null) {
                withStyle(SpanStyle(fontSize = maxOf(10f, style.fontSize.value * 0.34f).sp, color = color.copy(alpha = 0.72f), letterSpacing = 0.02.em)) { append("\u2002$unit") }
            }
        },
        style = style,
        color = color,
        modifier = modifier,
    )
}

/** The signature control: ink bar, mint knob at its head. Reversed = mint bar, ink knob. */
@Composable
fun KnobBar(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, reversed: Boolean = false) {
    val bar = if (reversed) WrkColors.mint else WrkColors.ink
    val knob = if (reversed) WrkColors.ink else WrkColors.mint
    val onBar = if (reversed) WrkColors.mintInk else WrkColors.onInk
    val onKnob = if (reversed) WrkColors.onInk else WrkColors.mintInk
    Box(
        modifier.fillMaxWidth().height(64.dp).alpha(if (enabled) 1f else 0.4f)
            .clip(Pill).background(bar)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(6.dp),
    ) {
        Box(Modifier.size(52.dp).clip(CircleShape).background(knob).align(Alignment.CenterStart), contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(18.dp)) {
                val p = Path().apply { moveTo(size.width * 0.3f, size.height * 0.15f); lineTo(size.width * 0.8f, size.height * 0.5f); lineTo(size.width * 0.3f, size.height * 0.85f); close() }
                drawPath(p, onKnob)
            }
        }
        Text(
            label, style = WrkType.title.copy(fontSize = 17.sp), color = onBar, textAlign = TextAlign.Center,
            modifier = Modifier.align(Alignment.Center).padding(start = 52.dp),
        )
    }
}

@Composable
fun InkButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Box(
        modifier.clip(Pill).background(WrkColors.ink).alpha(if (enabled) 1f else 0.4f)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 20.dp, vertical = 16.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = WrkType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = WrkColors.onInk) }
}

@Composable
fun PaperButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier.lift(Pill).clip(Pill).background(WrkColors.paper)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 20.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = WrkType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = WrkColors.foreground) }
}

@Composable
fun ButterButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier.clip(Pill).background(WrkColors.butter)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 20.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = WrkType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = WrkColors.butterInk) }
}


/** Ink bar at panel radius with a record disc cut out of its top edge. */
@Composable
fun Dock(labels: Pair<String, String>, selected: Int?, onSelect: (Int) -> Unit, onDisc: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().background(WrkColors.bone).navigationBarsPadding().padding(start = 16.dp, end = 16.dp, bottom = 12.dp, top = 14.dp)) {
        Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(WrkShape.panel)).background(WrkColors.ink).padding(top = 10.dp, bottom = 8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                DockItem(0, labels.first, selected == 0, { onSelect(0) }, Modifier.weight(1f).padding(end = 40.dp))
                DockItem(1, labels.second, selected == 1, { onSelect(1) }, Modifier.weight(1f).padding(start = 40.dp))
            }
        }
        Box(
            Modifier.align(Alignment.TopCenter).offset(y = (-24).dp).size(68.dp)
                .lift(CircleShape).clip(CircleShape).background(WrkColors.bone).padding(5.dp)
                .clip(CircleShape).background(WrkColors.ink).clickable(role = Role.Button, onClick = onDisc),
            contentAlignment = Alignment.Center,
        ) { Box(Modifier.size(22.dp).clip(CircleShape).background(WrkColors.onInk)) }
    }
}

@Composable
private fun DockItem(index: Int, label: String, active: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val c = if (active) WrkColors.onInk else WrkColors.onInkMuted
    Column(modifier.clickable(role = Role.Tab, onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Canvas(Modifier.size(22.dp)) {
            val w = 1.8.dp.toPx()
            val st = Stroke(w, cap = StrokeCap.Round)
            if (index == 0) {
                drawRoundRect(c, topLeft = Offset(size.width * .12f, size.height * .12f), size = androidx.compose.ui.geometry.Size(size.width * .76f, size.height * .76f), cornerRadius = androidx.compose.ui.geometry.CornerRadius(6.dp.toPx()), style = st)
            } else {
                for (i in 0..2) { val y = size.height * (.25f + .25f * i); drawLine(c, Offset(size.width * .15f, y), Offset(size.width * .85f, y), w, StrokeCap.Round) }
            }
        }
        Text(label, style = WrkType.label, color = c)
    }
}

/** Pill-shaped text input on paper, in the app's type. */
@Composable
fun WrkTextField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    keyboardType: androidx.compose.ui.text.input.KeyboardType = androidx.compose.ui.text.input.KeyboardType.Text,
    enabled: Boolean = true,
) {
    androidx.compose.foundation.text.BasicTextField(
        value = value,
        onValueChange = onChange,
        enabled = enabled,
        singleLine = true,
        textStyle = WrkType.body.copy(color = WrkColors.foreground, fontSize = 16.sp),
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = keyboardType),
        cursorBrush = androidx.compose.ui.graphics.SolidColor(WrkColors.foreground),
        modifier = modifier.fillMaxWidth().clip(Pill).background(WrkColors.paper).padding(horizontal = 20.dp, vertical = 16.dp),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) Text(placeholder, style = WrkType.body.copy(fontSize = 16.sp), color = WrkColors.subtle)
                inner()
            }
        },
    )
}
