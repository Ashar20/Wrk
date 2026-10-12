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
import com.wrk.app.design.InkButton
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkType

/** Shown once, before the first recording: what happens to a take, who can see it, and what to keep out of frame. */
@Composable
fun PrivacyScreen(onAccept: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        PaperButton("Back", onBack)
        Text("Before you record", style = WrkType.headline.copy(fontSize = 30.sp), color = WrkColors.foreground, modifier = Modifier.padding(top = 8.dp))
        Text("A take is a real video of your surroundings, so here is exactly where it goes.", style = WrkType.body, color = WrkColors.muted)

        PaperCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Tag("Who can see your take")
                Text("Wrk's automatic checks always. A reviewer, if the task asks for one. And the buyer who posted the task, once your take is accepted.", style = WrkType.body, color = WrkColors.foreground)
                Text("Buyers use accepted takes to train AI. They also see your payment address and the approximate area you recorded in (about 1 km), not your exact location.", style = WrkType.body, color = WrkColors.foreground)
                Text("Refused takes are never given to a buyer.", style = WrkType.body, color = WrkColors.foreground)
            }
        }

        PaperCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Tag("Keep these out of frame")
                Text("Faces, especially children. Screens and documents. Names, addresses, bank or ID cards, and anything else you wouldn't show a stranger.", style = WrkType.body, color = WrkColors.foreground)
                Text("Wrk doesn't blur faces for you yet, so what you record is what is shared. You can watch your take and delete it before it is sent.", style = WrkType.body, color = WrkColors.foreground)
            }
        }

        InkButton("I understand, start recording", onAccept, Modifier.fillMaxWidth().padding(top = 4.dp))
    }
}
