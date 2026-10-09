package com.wrk.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wrk.app.design.InkButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkType
import com.wrk.app.trust.TrustFactor
import com.wrk.app.trust.TrustReport
import java.text.DateFormat
import java.util.Date

internal fun tierLabel(t: String) = when (t) { "trusted" -> "Trusted"; "building" -> "Building trust"; else -> "New" }

/** What a factor shows on the right: "+15" earned, "0 / 15" missing, "−10" deducted. */
internal fun factorValue(f: TrustFactor) = when {
    f.points < 0 -> "−${-f.points}"
    f.max > 0 && f.points == 0 -> "0 / ${f.max}"
    f.max > 0 -> "+${f.points}"
    else -> "${f.points}"
}

/** Deductions only appear once they apply; the rest always show, so a person can see what they could still earn. */
internal fun visibleFactors(r: TrustReport) = r.factors.filter { it.max > 0 || it.points != 0 }

/** How much Wrk trusts this account, why, and how to raise it. The score is also what sets the daily allowance. */
@Composable
fun TrustCard(report: TrustReport?, onLiveCheck: (() -> Unit)?, modifier: Modifier = Modifier) {
    PaperCard(modifier.fillMaxWidth()) {
        if (report == null) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Tag("Your trust score")
                Text("Not available right now", style = WrkType.body, color = WrkColors.muted)
            }
            return@PaperCard
        }
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Tag("Your trust score")
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${report.score}", style = WrkType.figureHero, color = WrkColors.foreground)
                Text("/ 100", style = WrkType.title.copy(fontSize = 17.sp), color = WrkColors.muted, modifier = Modifier.padding(bottom = 6.dp))
            }
            Meter(tierLabel(report.tier), report.score / 100.0, "Today: ${report.used} of ${report.cap} takes. The allowance grows as your score does.")
            visibleFactors(report).forEach { f ->
                Column {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(f.label, style = WrkType.body, color = WrkColors.foreground)
                        Text(factorValue(f), style = WrkType.data.copy(fontWeight = FontWeight.Medium), color = if (f.points < 0) WrkColors.negative else WrkColors.muted)
                    }
                    if (f.note != null && (f.points < f.max || f.points < 0)) Text(f.note, style = WrkType.label.copy(fontSize = 12.sp), color = WrkColors.subtle)
                }
            }
            val until = report.liveVerifiedUntil
            if (until != null) Tag("Verified live until ${DateFormat.getDateInstance().format(Date(until))}")
            else if (onLiveCheck != null) InkButton("Verify you're live (about 20 seconds)", onLiveCheck, Modifier.fillMaxWidth())
        }
    }
}
