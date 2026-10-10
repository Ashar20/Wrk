package com.wrk.app.ui

import android.content.Intent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.wrk.app.design.Chip
import com.wrk.app.design.FieldCard
import com.wrk.app.design.Figure
import com.wrk.app.design.InkButton
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkTextField
import com.wrk.app.design.WrkType
import com.wrk.app.roles.ApiException
import com.wrk.app.roles.BuyerApi
import com.wrk.app.roles.BuyerBounty
import com.wrk.app.roles.BuyerSummary
import com.wrk.app.roles.budgetFor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale

/**
 * Funds a task whose money isn't locked yet: a wallet buyer signs the transaction and Wrk waits for it to land.
 * Returns a message to show, or null once the task is open.
 */
suspend fun fundTask(api: BuyerApi, id: String, tx: String, onSignAndSend: suspend (String) -> String?): String? {
    onSignAndSend(tx)?.let { return it }
    repeat(8) {
        if (api.confirm(id)) return null
        delay(2_000)
    }
    return "Funding was sent but hasn't shown up yet. Check back in a moment."
}

@Composable
fun BuyerDashboardScreen(api: BuyerApi, onSignAndSend: suspend (String) -> String?, onOpen: (BuyerBounty) -> Unit, onNew: () -> Unit, onModel: () -> Unit, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var fundingProblem by remember { mutableStateOf<String?>(null) }
    val state by produceState<Result<BuyerSummary>?>(null) {
        while (true) { value = runCatching { api.summary() }; delay(6_000) }
    }
    LazyColumn(modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        item {
            Column(Modifier.padding(top = 12.dp)) {
                Text("Your tasks", style = WrkType.title, color = WrkColors.foreground)
                Tag("Spent on accepted takes", modifier = Modifier.padding(top = 20.dp))
                Figure(state?.getOrNull()?.totalSpendUsd ?: 0.0, WrkType.figureLead, knockDownCents = true)
            }
        }
        item { InkButton("Post a new task", onNew, Modifier.fillMaxWidth()) }
        item { PaperButton("What the data is worth", onModel, Modifier.fillMaxWidth()) }
        val r = state
        if (r?.isFailure == true) item {
            FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text((r.exceptionOrNull() as? ApiException)?.message ?: "Couldn't load your tasks.", style = WrkType.body, color = WrkColors.butterInk) }
        }
        fundingProblem?.let { item { FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(it, style = WrkType.body, color = WrkColors.butterInk) } } }
        items(r?.getOrNull()?.bounties.orEmpty(), key = { it.id }) { b ->
            BuyerBountyCard(b, onFinishFunding = {
                scope.launch {
                    fundingProblem = try { fundTask(api, b.id, api.fundTx(b.id), onSignAndSend) } catch (e: ApiException) { e.message }
                }
            }) { onOpen(b) }
        }
    }
}

@Composable
private fun BuyerBountyCard(b: BuyerBounty, onFinishFunding: () -> Unit, onClick: () -> Unit) {
    PaperCard(Modifier.fillMaxWidth(), onClick = onClick) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(b.title, style = WrkType.title, color = WrkColors.foreground, modifier = Modifier.weight(1f))
                if (!b.open) Tag("Full")
            }
            Tag(if (b.ownerIsYou) "Posted by you" else "Wrk demo task")
            listOfNotNull("Verified phones only".takeIf { b.verifiedOnly }, "Live check".takeIf { b.liveCheck }, "Reviewed by a person".takeIf { b.humanReview })
                .takeIf { it.isNotEmpty() }?.let { Tag(it.joinToString(" · ")) }
            b.escrow?.let { e ->
                if (e.funded) Tag("Locked in escrow${e.lockedUsd?.let { String.format(Locale.US, " · $%.2f", it) } ?: ""}")
                else if (b.ownerIsYou) {
                    FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Waiting for funding. Nobody can record takes until the money is locked.", style = WrkType.body, color = WrkColors.butterInk)
                            com.wrk.app.design.ButterButton("Finish funding", onFinishFunding, Modifier.fillMaxWidth())
                        }
                    }
                }
            }
            Meter("${b.accepted} of ${b.minEpisodes} takes", (b.accepted.toDouble() / b.minEpisodes).coerceIn(0.0, 1.0), "${b.rejected} rejected · ${b.inReview} in review · ${b.scoring} checking")
        }
    }
}

@Composable
fun BuyerBountyScreen(first: BuyerBounty, api: BuyerApi, onSignAndSend: suspend (String) -> String?, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    // Starts from what was tapped, then keeps itself fresh as takes arrive.
    val b by produceState(first) {
        while (true) {
            delay(6_000)
            runCatching { api.summary().bounties.firstOrNull { it.id == first.id } }.getOrNull()?.let { value = it }
        }
    }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        PaperButton("Back", onBack)
        Text(b.title, style = WrkType.title, color = WrkColors.foreground)
        Row(horizontalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
            PaperCard(Modifier.weight(1f)) { Column { Tag("Accepted"); Text("${b.accepted}", style = WrkType.figureLead, color = WrkColors.foreground) } }
            PaperCard(Modifier.weight(1f)) { Column { Tag("Rejected"); Text("${b.rejected}", style = WrkType.figureLead, color = WrkColors.foreground) } }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
            PaperCard(Modifier.weight(1f)) { Column { Tag("In review"); Text("${b.inReview}", style = WrkType.figureLead, color = WrkColors.foreground) } }
            PaperCard(Modifier.weight(1f)) { Column { Tag("Spent"); Figure(b.spendUsd, WrkType.figureLead, knockDownCents = true) } }
        }
        PaperCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("How the takes scored", style = WrkType.body.copy(fontWeight = FontWeight.Medium), color = WrkColors.foreground)
                ScoreBars(b.histogram)
                Tag(b.avgPlausibility?.let { "Average motion match ${Math.round(it * 100)}%" } ?: "No scored takes yet")
            }
        }
        b.escrow?.let { e ->
            PaperCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Tag("Locked in escrow")
                    Figure(e.lockedUsd ?: 0.0, WrkType.figureLead, knockDownCents = true)
                    Tag(if (e.funded) "Held by the task's on-chain vault. Only accepted takes can be paid from it." else "Waiting for funding")
                    if (e.deadline > 0) Tag("Unspent funds can be taken back after " + java.text.DateFormat.getDateInstance().format(java.util.Date(e.deadline * 1000)))
                }
            }
            if (e.canRefund) InkButton(if (busy) "Working…" else "Take back unspent funds", {
                if (busy) return@InkButton
                scope.launch {
                    busy = true; problem = null
                    try {
                        val r = api.refund(b.id)
                        problem = if (r.tx != null) onSignAndSend(r.tx) ?: "Done. The unspent funds are back in your payment account." else "Done. The unspent funds are back in your payment account."
                    } catch (ex: ApiException) { problem = ex.message } finally { busy = false }
                }
            }, Modifier.fillMaxWidth(), enabled = !busy)
        }
        PaperCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Tag("Budget")
                Figure(b.budgetUsd, WrkType.figureInline, knockDownCents = true, unit = "for ${b.minEpisodes} takes at ${String.format(Locale.US, "$%.2f", b.perEpisodeUsd)}")
                if (b.humanReview) Tag("A person reviews close calls")
            }
        }
        problem?.let { FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(it, style = WrkType.body, color = WrkColors.butterInk) } }
        InkButton(if (busy) "Preparing…" else "Share dataset manifest", {
            if (busy) return@InkButton
            scope.launch {
                busy = true; problem = null
                try {
                    val json = api.dataset(b.id)
                    val uri = withContext(Dispatchers.IO) {
                        val f = File(File(context.cacheDir, "shared").apply { mkdirs() }, "wrk-${b.id}.json").also { it.writeText(json) }
                        FileProvider.getUriForFile(context, "${context.packageName}.files", f)
                    }
                    context.startActivity(
                        Intent.createChooser(
                            Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
                            "Share dataset manifest",
                        ),
                    )
                } catch (e: ApiException) { problem = e.message } catch (e: Exception) { problem = "Couldn't prepare the file. Try again." }
                finally { busy = false }
            }
        }, Modifier.fillMaxWidth(), enabled = !busy && b.accepted > 0)
        if (b.accepted == 0) Tag("The manifest lists accepted takes, so it unlocks after the first one.")
    }
}

/** Five bars, lowest score band to highest. Only the count matters, so no axis, just the numbers. */
@Composable
private fun ScoreBars(h: List<Int>) {
    val top = (h.maxOrNull() ?: 0).coerceAtLeast(1)
    val labels = listOf("0–20", "20–40", "40–60", "60–80", "80–100")
    Row(Modifier.fillMaxWidth().height(110.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        h.forEachIndexed { i, n ->
            Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
                Box(Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(WrkShape.inner)).background(WrkColors.paperSunk), contentAlignment = androidx.compose.ui.Alignment.BottomCenter) {
                    Box(Modifier.fillMaxWidth().fillMaxHeight(if (n == 0) 0f else (0.12f + 0.88f * n / top)).background(if (i >= 3) WrkColors.mintInk else if (i == 2) WrkColors.butterInk else WrkColors.negative))
                }
                Text("$n", style = WrkType.figureInline.copy(fontSize = 13.sp), color = WrkColors.foreground, modifier = Modifier.padding(top = 4.dp))
                Text(labels[i], style = WrkType.label.copy(fontSize = 9.sp), color = WrkColors.subtle)
            }
        }
    }
}

@Composable
fun NewBountyScreen(api: BuyerApi, onSignAndSend: suspend (String) -> String?, onCreated: () -> Unit, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var spec by remember { mutableStateOf("") }
    var pay by remember { mutableStateOf("0.60") }
    var takes by remember { mutableStateOf("50") }
    var review by remember { mutableStateOf(false) }
    var verifiedOnly by remember { mutableStateOf(false) }
    var liveCheck by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    val perTake = pay.toDoubleOrNull()
    val count = takes.toIntOrNull()
    val valid = title.trim().length >= 3 && spec.trim().length >= 10 && perTake != null && perTake in 0.10..20.0 && count != null && count in 1..1000
    val budget = if (perTake != null && count != null && valid) budgetFor(perTake, count) else null

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        Text("Post a task", style = WrkType.headline.copy(fontSize = 30.sp), color = WrkColors.foreground, modifier = Modifier.padding(top = 8.dp))
        Text("Describe what you need. People record it, Wrk checks every take, and you only pay for the accepted ones.", style = WrkType.body, color = WrkColors.muted)
        PaperCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
                Tag("Task name")
                WrkTextField(title, { title = it.take(80) }, "Water a houseplant")
                Tag("What should they do?")
                WrkTextField(spec, { spec = it.take(600) }, "Water a houseplant with a small can, first-person view.")
                Tag("Pay per accepted take (USD)")
                WrkTextField(pay, { pay = it.filter { c -> c.isDigit() || c == '.' }.take(6) }, "0.60", keyboardType = KeyboardType.Decimal)
                Tag("How many takes")
                WrkTextField(takes, { takes = it.filter(Char::isDigit).take(4) }, "50", keyboardType = KeyboardType.Number)
                Tag("Who can take part")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip("Any phone", !verifiedOnly) { verifiedOnly = false }
                    Chip("Only verified phones", verifiedOnly) { verifiedOnly = true }
                }
                Tag("Proof the recording is live")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip("Not required", !liveCheck) { liveCheck = false }
                    Chip("Head-movement check", liveCheck) { liveCheck = true }
                }
                Tag("Close calls")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip("Checked automatically", !review) { review = false }
                    Chip("A person reviews them", review) { review = true }
                }
            }
        }
        if (budget != null) {
            PaperCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Tag("Budget")
                    Figure(budget.totalUsd, WrkType.figureLead, knockDownCents = true)
                    Tag(String.format(Locale.US, "Takes $%.2f · bonus pool $%.2f · reviewers $%.2f · Wrk $%.2f", budget.takesUsd, budget.utilityUsd, budget.validatorsUsd, budget.treasuryUsd))
                    Tag("The money for every take is locked in an on-chain escrow before your task opens. On devnet we add free test funds for you.")
                }
            }
        }
        problem?.let { FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(it, style = WrkType.body, color = WrkColors.butterInk) } }
        Spacer(Modifier.height(4.dp))
        InkButton(if (busy) "Posting…" else "Post task", {
            if (busy || perTake == null || count == null) return@InkButton
            scope.launch {
                busy = true; problem = null
                try {
                    val t = api.create(title.trim(), spec.trim(), perTake, count, review, verifiedOnly, liveCheck)
                    if (!t.funded && t.tx != null) {
                        problem = fundTask(api, t.id, t.tx, onSignAndSend)
                        // Posted either way: if funding didn't finish, it's on the dashboard with a "Finish funding" button.
                        if (problem == null) onCreated()
                    } else onCreated()
                } catch (e: ApiException) { problem = e.message } finally { busy = false }
            }
        }, Modifier.fillMaxWidth(), enabled = valid && !busy)
    }
}
