package com.wrk.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.wrk.app.data.ApiBountyRepository
import com.wrk.app.data.Bounty
import com.wrk.app.data.StaticBountyRepository
import com.wrk.app.design.Dock
import com.wrk.app.design.DockTab
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkTheme
import com.wrk.app.ui.BountyDetailScreen
import com.wrk.app.ui.HomeScreen

class MainActivity : ComponentActivity() {
    private val bounties = ApiBountyRepository(BuildConfig.API_BASE)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { WrkTheme { WrkApp(bounties) } }
    }
}

@Composable
private fun WrkApp(repo: ApiBountyRepository) {
    val nav = rememberNavController()
    val list by produceState<List<Bounty>?>(null) { value = repo.bounties() }
    val bounties = list ?: emptyList()

    Column(Modifier.fillMaxSize().background(WrkColors.bone).statusBarsPadding()) {
        NavHost(nav, startDestination = "home", modifier = Modifier.weight(1f)) {
            composable("home") { HomeScreen(bounties, earnedUsd = 0.0, onOpen = { nav.navigate("bounty/${it.id}") }) }
            composable("bounty/{id}") { entry ->
                val b = bounties.firstOrNull { it.id == entry.arguments?.getString("id") }
                if (b != null) BountyDetailScreen(b, onStart = { /* capture arrives in the capture task */ }, onBack = { nav.popBackStack() })
            }
        }
        Dock(selected = DockTab.Tasks, onSelect = {}, onDisc = {})
    }
}
