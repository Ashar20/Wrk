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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.wrk.app.account.Account
import com.wrk.app.account.AuthApi
import com.wrk.app.data.ApiBountyRepository
import com.wrk.app.data.Bounty
import com.wrk.app.design.Dock
import com.wrk.app.design.DockTab
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkTheme
import com.wrk.app.ui.ActivityScreen
import com.wrk.app.ui.BountyDetailScreen
import com.wrk.app.ui.CaptureScreen
import com.wrk.app.ui.HomeScreen
import com.wrk.app.ui.PaymentAccountScreen
import com.wrk.app.ui.ReviewScreen
import com.wrk.app.ui.SubmissionScreen
import com.wrk.app.upload.SubmissionService
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    // Must exist before the activity starts so Mobile Wallet Adapter can register its result launcher.
    private val sender = ActivityResultSender(this)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = WrkContainer.get(this)
        setContent { WrkTheme { WrkApp(container, sender) } }
    }
}

@Composable
private fun WrkApp(c: WrkContainer, sender: ActivityResultSender) {
    val context = LocalContext.current
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val repo = remember { ApiBountyRepository(BuildConfig.API_BASE) }
    val auth = remember { AuthApi(BuildConfig.API_BASE) }
    val service = remember { SubmissionService(context.applicationContext, c) }
    val list by produceState<List<Bounty>?>(null) { value = repo.bounties() }
    val bounties = list ?: emptyList()
    var account by remember { mutableStateOf(c.accounts.load()) }
    val earned by produceState(0.0) { while (true) { value = c.episodes.earnedUsd; delay(2000) } }
    val route = nav.currentBackStackEntryAsState().value?.destination?.route

    fun goHome() { nav.navigate("home") { popUpTo("home") { inclusive = true } } }

    Column(Modifier.fillMaxSize().background(WrkColors.bone).statusBarsPadding()) {
        NavHost(nav, startDestination = "home", modifier = Modifier.weight(1f)) {
            composable("home") {
                HomeScreen(bounties, earned, account, onAccount = { nav.navigate("account") }, onOpen = { nav.navigate("bounty/${it.id}") })
            }
            composable("bounty/{id}") { e ->
                val b = bounties.firstOrNull { it.id == e.arguments?.getString("id") }
                if (b != null) BountyDetailScreen(b, onStart = { nav.navigate("capture/${b.id}") }, onBack = { nav.popBackStack() })
            }
            composable("capture/{id}") { e ->
                val b = bounties.firstOrNull { it.id == e.arguments?.getString("id") }
                if (b != null) CaptureScreen(
                    b, c,
                    onCaptured = { c.pending = it; nav.navigate("review") { popUpTo("bounty/${b.id}") } },
                    onBack = { nav.popBackStack() },
                )
            }
            composable("review") {
                val p = c.pending
                if (p == null) { goHome() } else ReviewScreen(
                    pending = p,
                    hasAccount = account != null,
                    onSubmit = { report ->
                        val id = service.submit(p, checkNotNull(account), report)
                        nav.navigate("submission/$id") { popUpTo("home") }
                    },
                    onNeedAccount = { nav.navigate("account") },
                    onDiscard = {
                        c.episodes.delete(p.episodeId); c.pending = null
                        nav.popBackStack("bounty/${p.bounty.id}", false).let { ok -> if (!ok) goHome() }
                    },
                )
            }
            composable("submission/{id}") { e ->
                val id = e.arguments?.getString("id").orEmpty()
                SubmissionScreen(
                    id = id, store = c.episodes,
                    onApprovePayout = { (account as? Account.Wallet)?.let { service.approvePayout(id, it, sender) } ?: "Connect your wallet first." },
                    onRetry = { service.retry(id) },
                    onRecordAgain = { nav.navigate("bounty/${c.episodes.state(id)?.bountyId}") { popUpTo("home") } },
                    onDelete = { c.episodes.delete(id); goHome() },
                    onBack = { goHome() },
                )
            }
            composable("activity") {
                ActivityScreen(c.episodes, onOpen = { nav.navigate("submission/${it.id}") })
            }
            composable("account") {
                PaymentAccountScreen(
                    current = account,
                    auth = auth,
                    onConnectWallet = { c.wallet.connect(sender) },
                    onSignedIn = { c.accounts.save(it); account = it; nav.popBackStack() },
                    onSignOut = {
                        scope.launch {
                            if (account is Account.Wallet) c.wallet.disconnect(sender)
                            c.accounts.clear(); account = null
                        }
                    },
                    onBack = { nav.popBackStack() },
                )
            }
        }
        Dock(
            selected = when { route == "activity" -> DockTab.Activity; route == "home" -> DockTab.Tasks; else -> null },
            onSelect = { tab -> if (tab == DockTab.Tasks) goHome() else nav.navigate("activity") { popUpTo("home") } },
            onDisc = { bounties.firstOrNull()?.let { nav.navigate("bounty/${it.id}") { popUpTo("home") } } },
        )
    }
}
