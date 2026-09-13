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
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.wrk.app.account.Account
import com.wrk.app.account.AccountStore
import com.wrk.app.account.AuthApi
import com.wrk.app.account.EncryptedKeyValue
import com.wrk.app.data.ApiBountyRepository
import com.wrk.app.data.Bounty
import com.wrk.app.design.Dock
import com.wrk.app.design.DockTab
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkTheme
import com.wrk.app.ui.BountyDetailScreen
import com.wrk.app.ui.HomeScreen
import com.wrk.app.ui.PaymentAccountScreen
import com.wrk.app.wallet.WalletManager
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    // Must exist before the activity starts so Mobile Wallet Adapter can register its result launcher.
    private val sender = ActivityResultSender(this)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val store = AccountStore(EncryptedKeyValue(applicationContext))
        val deps = Deps(ApiBountyRepository(BuildConfig.API_BASE), AuthApi(BuildConfig.API_BASE), store, WalletManager(store), sender)
        setContent { WrkTheme { WrkApp(deps) } }
    }
}

private class Deps(
    val bounties: ApiBountyRepository,
    val auth: AuthApi,
    val store: AccountStore,
    val wallet: WalletManager,
    val sender: ActivityResultSender,
)

@Composable
private fun WrkApp(d: Deps) {
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val list by produceState<List<Bounty>?>(null) { value = d.bounties.bounties() }
    val bounties = list ?: emptyList()
    var account by remember { mutableStateOf(d.store.load()) }

    Column(Modifier.fillMaxSize().background(WrkColors.bone).statusBarsPadding()) {
        NavHost(nav, startDestination = "home", modifier = Modifier.weight(1f)) {
            composable("home") {
                HomeScreen(bounties, earnedUsd = 0.0, account = account, onAccount = { nav.navigate("account") }, onOpen = { nav.navigate("bounty/${it.id}") })
            }
            composable("bounty/{id}") { entry ->
                val b = bounties.firstOrNull { it.id == entry.arguments?.getString("id") }
                if (b != null) BountyDetailScreen(b, onStart = { /* capture arrives in the capture task */ }, onBack = { nav.popBackStack() })
            }
            composable("account") {
                PaymentAccountScreen(
                    current = account,
                    auth = d.auth,
                    onConnectWallet = { d.wallet.connect(d.sender) },
                    onSignedIn = { d.store.save(it); account = it; nav.popBackStack() },
                    onSignOut = {
                        scope.launch {
                            if (account is Account.Wallet) d.wallet.disconnect(d.sender)
                            d.store.clear(); account = null
                        }
                    },
                    onBack = { nav.popBackStack() },
                )
            }
        }
        Dock(selected = DockTab.Tasks, onSelect = {}, onDisc = {})
    }
}
