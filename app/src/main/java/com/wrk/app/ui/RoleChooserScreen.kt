package com.wrk.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wrk.app.account.Role
import com.wrk.app.design.FieldCard
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkType

/** One sign-in, three ways in. Mint is the work you can do, lilac is judgement, paper is the buyer's ledger. */
@Composable
fun RoleChooserScreen(current: Role?, title: String, onPick: (Role) -> Unit, onBack: (() -> Unit)?, modifier: Modifier = Modifier, problem: String? = null) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        if (onBack != null) PaperButton("Back", onBack)
        Text(title, style = WrkType.headline.copy(fontSize = 30.sp), color = WrkColors.foreground, modifier = Modifier.padding(top = 8.dp))
        Text("You can switch any time from your account.", style = WrkType.body, color = WrkColors.muted)
        problem?.let { FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(it, style = WrkType.body, color = WrkColors.butterInk) } }
        Role.entries.forEach { role ->
            val bg = when (role) { Role.Contributor -> WrkColors.mint; Role.Verifier -> WrkColors.lilac; Role.Buyer -> WrkColors.paper }
            val fg = when (role) { Role.Contributor -> WrkColors.mintInk; Role.Verifier -> WrkColors.lilacInk; Role.Buyer -> WrkColors.foreground }
            if (role == Role.Buyer) PaperCard(Modifier.fillMaxWidth(), onClick = { onPick(role) }) { RoleBody(role, fg, current == role) }
            else FieldCard(bg, Modifier.fillMaxWidth(), onClick = { onPick(role) }) { RoleBody(role, fg, current == role) }
        }
    }
}

@Composable
private fun RoleBody(role: Role, fg: androidx.compose.ui.graphics.Color, selected: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(role.label + if (selected) "  ·  current" else "", style = WrkType.title, color = fg)
        Text(role.blurb, style = WrkType.body, color = fg)
        if (role.needsSession) Tag("Uses your sign-in to know who you are", fg)
    }
}
