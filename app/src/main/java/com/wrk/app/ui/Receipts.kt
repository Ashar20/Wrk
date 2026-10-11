package com.wrk.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import com.wrk.app.BuildConfig
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkType

/** One thing that happened on Solana: what it was, the transaction, and a link to see it for real. */
data class Receipt(val label: String, val signature: String)

fun txUrl(signature: String) = "https://explorer.solana.com/tx/$signature?cluster=${BuildConfig.SOLANA_CLUSTER}"
fun addressUrl(address: String) = "https://explorer.solana.com/address/$address?cluster=${BuildConfig.SOLANA_CLUSTER}"

private fun short(s: String) = "${s.take(8)}\u2026${s.takeLast(6)}"

/** Every transaction behind a take, a decision or a task, each opening on the public explorer. Hidden when there are none. */
@Composable
fun Receipts(items: List<Receipt>, modifier: Modifier = Modifier, title: String = "On Solana") {
    val real = items.filter { it.signature.isNotBlank() && it.signature != "not-required" }
    if (real.isEmpty()) return
    val uri = LocalUriHandler.current
    PaperCard(modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Tag(title)
            real.forEach { r ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(r.label, style = WrkType.body, color = WrkColors.foreground)
                        Text(short(r.signature), style = WrkType.data, color = WrkColors.subtle)
                    }
                    PaperButton("View on Solana Explorer", { uri.openUri(txUrl(r.signature)) }, Modifier.fillMaxWidth())
                }
            }
        }
    }
}
