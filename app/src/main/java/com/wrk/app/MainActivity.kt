package com.wrk.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wrk.app.design.WrkType
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.wrk.app.account.Account
import com.wrk.app.account.label
import com.wrk.app.account.AuthApi
import com.wrk.app.account.AuthException
import com.wrk.app.account.Role
import com.wrk.app.account.SessionService
import com.wrk.app.data.ApiBountyRepository
import com.wrk.app.data.Bounty
import com.wrk.app.design.Dock
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkTheme
import com.wrk.app.roles.BuyerApi
import com.wrk.app.roles.BuyerBounty
import com.wrk.app.roles.JsonApi
import com.wrk.app.roles.ReviewApi
import com.wrk.app.roles.ReviewItem
import com.wrk.app.ui.ActivityScreen
import com.wrk.app.ui.BountyDetailScreen
import com.wrk.app.ui.BuyerBountyScreen
import com.wrk.app.ui.BuyerDashboardScreen
import com.wrk.app.ui.CaptureScreen
import com.wrk.app.ui.HomeScreen
import com.wrk.app.ui.NewBountyScreen
import com.wrk.app.ui.PaymentAccountScreen
import com.wrk.app.ui.ReviewDetailScreen
import com.wrk.app.ui.ReviewHistoryScreen
import com.wrk.app.ui.ReviewQueueScreen
import com.wrk.app.ui.ReviewScreen
import com.wrk.app.ui.RoleChooserScreen
import com.wrk.app.ui.SubmissionScreen
import com.wrk.app.trust.TrustApi
import com.wrk.app.ui.LiveCheckRunScreen
import com.wrk.app.ui.LiveCheckTask
import com.wrk.app.upload.LiveCheckService
import com.wrk.app.upload.SubmissionService
import com.wrk.app.wallet.WalletResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    // Must exist before the activity starts so Mobile Wallet Adapter can register its result launcher.
    private val sender = ActivityResultSender(this)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Light ground, so system bar icons must be dark.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        val container = WrkContainer.get(this)
        setContent { WrkTheme { WrkApp(container, sender) } }
    }
}

private fun homeFor(r: Role) = when (r) { Role.Contributor -> "home"; Role.Verifier -> "queue"; Role.Buyer -> "dash" }

private fun dockLabels(r: Role) = when (r) {
    Role.Contributor -> "Tasks" to "Activity"
    Role.Verifier -> "Queue" to "History"
    Role.Buyer -> "Tasks" to "Post a task"
}

private fun dockSelection(r: Role, route: String?) = when (r) {
    Role.Contributor -> when (route) { "home" -> 0; "activity" -> 1; else -> null }
    Role.Verifier -> when (route) { "queue" -> 0; "rhistory" -> 1; else -> null }
    Role.Buyer -> when (route) { "dash" -> 0; "newtask" -> 1; else -> null }
}

@Composable
private fun WrkApp(c: WrkContainer, sender: ActivityResultSender) {
    val context = LocalContext.current
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val repo = remember { ApiBountyRepository(BuildConfig.API_BASE) }
    val auth = remember { AuthApi(BuildConfig.API_BASE) }
    val sessions = remember { SessionService(auth, c.wallet) }
    val service = remember { SubmissionService(context.applicationContext, c) }
    val liveService = remember { LiveCheckService(c) }
    val trustApi = remember { TrustApi(JsonApi(BuildConfig.API_BASE, { null })) }
    // The store is the source of truth for the session, so every call sees a fresh token.
    val json = remember { JsonApi(BuildConfig.API_BASE, { c.accounts.load()?.sessionToken }) }
    val reviewApi = remember { ReviewApi(json) }
    val buyerApi = remember { BuyerApi(json) }

    val list by produceState<List<Bounty>?>(null) { value = repo.bounties() }
    val bounties = list ?: emptyList()
    var account by remember { mutableStateOf(c.accounts.load()) }
    var role by remember { mutableStateOf(c.accounts.role) }
    var rolesProblem by remember { mutableStateOf<String?>(null) }
    var selectedReview by remember { mutableStateOf<ReviewItem?>(null) }
    var selectedBuyer by remember { mutableStateOf<BuyerBounty?>(null) }
    val earned by produceState(0.0) { while (true) { value = c.episodes.earnedUsd; delay(2000) } }
    val route = nav.currentBackStackEntryAsState().value?.destination?.route

    // Sign in first, and say how you'll use Wrk. Both are remembered across launches.
    val start = remember { if (c.accounts.load() == null || c.accounts.role == null) "login" else homeFor(c.accounts.role!!) }
    val activeRole = role ?: Role.Contributor

    // Quietly verify this phone once, so takes can be signed. Failure just means takes are unattested.
    val phone by produceState<String?>(null) {
        val st = c.device.ensureRegistered()
        value = when (st) {
            com.wrk.app.device.DeviceStatus.Verified -> "Verified"
            com.wrk.app.device.DeviceStatus.Limited -> "Registered, but not fully verified"
            is com.wrk.app.device.DeviceStatus.Unavailable -> "Not verified: ${st.reason}"
        }
    }

    /** Hands a transaction the validator built to the buyer's wallet. Returns a message if it didn't go through. */
    val signAndSend: suspend (String) -> String? = { tx ->
        when (val r = c.wallet.signAndSend(sender, android.util.Base64.decode(tx, android.util.Base64.DEFAULT))) {
            is com.wrk.app.wallet.SendResult.Sent -> null
            com.wrk.app.wallet.SendResult.NoWalletInstalled -> "Your wallet app isn't available. Open it once, then try again."
            is com.wrk.app.wallet.SendResult.Failed -> r.message
        }
    }

    val signOut: () -> Unit = {
        scope.launch {
            if (account is Account.Wallet) c.wallet.disconnect(sender)
            c.accounts.clear(); account = null; role = null
            nav.navigate("login") { popUpTo(nav.graph.id) { inclusive = true } }
        }
    }
    fun goHome(r: Role = activeRole) { nav.navigate(homeFor(r)) { popUpTo(nav.graph.id) { inclusive = true } } }

    /** Verifier and Buyer need the validator to know who they are. Wallet users prove it by signing a message once. */
    suspend fun sessionFor(r: Role, a: Account?): Pair<Account?, String?> {
        if (!r.needsSession || a == null || a.sessionToken != null) return a to null
        if (a !is Account.Wallet) return a to "Sign in again to use this role."
        return try {
            val upgraded = Account.Wallet(a.address, sessions.walletToken(sender, a.address))
            c.accounts.save(upgraded)
            upgraded to null
        } catch (e: AuthException) { a to e.message }
    }

    Column(Modifier.fillMaxSize().background(WrkColors.bone).statusBarsPadding()) {
        // Who you are right now, on every screen: tap it to switch account or role.
        val who = account
        if (who != null && route != null && route !in setOf("login", "account", "roles", "profile", "capture/{id}")) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
                Box(
                    Modifier.clip(RoundedCornerShape(50)).background(WrkColors.paper)
                        .clickable(role = androidx.compose.ui.semantics.Role.Button) { nav.navigate("profile") }
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                ) { Text("${who.label} · ${activeRole.label}", style = WrkType.label.copy(fontSize = 12.sp), color = WrkColors.muted, maxLines = 1) }
            }
        }
        NavHost(nav, startDestination = start, modifier = Modifier.weight(1f)) {
            composable("login") {
                var picked by remember { mutableStateOf<Role?>(null) }
                val chosen = picked
                if (chosen == null) {
                    RoleChooserScreen(current = null, title = "How will you use Wrk?", onPick = { picked = it }, onBack = null)
                } else {
                    PaymentAccountScreen(
                        current = null,
                        auth = auth,
                        onConnectWallet = {
                            if (!chosen.needsSession) c.wallet.connect(sender)
                            else when (val r = c.wallet.connectAndSign(sender) { address -> auth.walletChallenge(address) }) {
                                // Verifier and Buyer: one approval in the wallet both connects and proves ownership.
                                is com.wrk.app.wallet.SignInResult.Ok -> try {
                                    WalletResult.Connected(r.address, auth.walletVerify(r.address, r.signature))
                                } catch (e: AuthException) { WalletResult.Failed(e.message ?: "Couldn't sign you in.") }
                                com.wrk.app.wallet.SignInResult.NoWalletInstalled -> WalletResult.NoWalletInstalled
                                is com.wrk.app.wallet.SignInResult.Failed -> WalletResult.Failed(r.message)
                            }
                        },
                        onSignedIn = {
                            c.accounts.save(it); c.accounts.role = chosen
                            account = it; role = chosen; goHome(chosen)
                        },
                        onSignOut = {},
                        onBack = { picked = null },
                        onboarding = true,
                        role = chosen,
                    )
                }
            }

            // ---- contributor -----------------------------------------------------------------------------------------
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
                if (p == null) { LaunchedEffect(Unit) { goHome() } } else ReviewScreen(
                    pending = p,
                    hasAccount = account != null,
                    onSubmit = { report ->
                        val id = service.submit(p, checkNotNull(account), report)
                        nav.navigate("submission/$id") { popUpTo(nav.graph.id) { inclusive = true } }
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
            composable("activity") { ActivityScreen(c.episodes, onOpen = { nav.navigate("submission/${it.id}") }) }

            // ---- verifier --------------------------------------------------------------------------------------------
            composable("queue") { ReviewQueueScreen(reviewApi, onOpen = { selectedReview = it; nav.navigate("rv") }) }
            composable("rv") {
                val item = selectedReview
                if (item == null) LaunchedEffect(Unit) { goHome() } else ReviewDetailScreen(item, reviewApi, onDone = { nav.popBackStack() }, onBack = { nav.popBackStack() })
            }
            composable("rhistory") { ReviewHistoryScreen(reviewApi) }

            // ---- buyer -----------------------------------------------------------------------------------------------
            composable("dash") { BuyerDashboardScreen(buyerApi, signAndSend, onOpen = { selectedBuyer = it; nav.navigate("bountyd") }, onNew = { nav.navigate("newtask") }, onModel = { nav.navigate("model") }) }
            composable("model") { com.wrk.app.ui.ModelScreen(buyerApi, onBack = { nav.popBackStack() }) }
            composable("bountyd") {
                val b = selectedBuyer
                if (b == null) LaunchedEffect(Unit) { goHome() } else BuyerBountyScreen(b, buyerApi, signAndSend, onBack = { nav.popBackStack() })
            }
            composable("newtask") { NewBountyScreen(buyerApi, signAndSend, onCreated = { goHome(Role.Buyer) }) }

            // ---- shared ----------------------------------------------------------------------------------------------
            composable("roles") {
                RoleChooserScreen(
                    current = role, title = "Switch role", problem = rolesProblem,
                    onBack = { nav.popBackStack() },
                    onPick = { picked ->
                        scope.launch {
                            rolesProblem = null
                            val (a, err) = sessionFor(picked, account)
                            if (err != null) { rolesProblem = err; return@launch }
                            account = a; c.accounts.role = picked; role = picked
                            goHome(picked)
                        }
                    },
                )
            }
            composable("livecheck") {
                CaptureScreen(
                    LiveCheckTask, c,
                    onCaptured = { c.pending = it; nav.navigate("livecheck/run") { popUpTo("livecheck") { inclusive = true } } },
                    onBack = { nav.popBackStack() },
                )
            }
            composable("livecheck/run") {
                val p = c.pending
                val a = account
                if (p == null || a == null) LaunchedEffect(Unit) { nav.popBackStack("account", false) }
                else LiveCheckRunScreen(
                    pending = p, account = a, service = liveService,
                    onTryAgain = { nav.navigate("livecheck") { popUpTo("account") } },
                    onDone = { nav.popBackStack("account", false) },
                )
            }
            composable("profile") {
                val a = account
                if (a == null) LaunchedEffect(Unit) { nav.navigate("login") { popUpTo(nav.graph.id) { inclusive = true } } }
                else {
                    // The score, and the history for whichever role this is, refreshed while the page is open.
                    val myTrust by produceState<com.wrk.app.trust.TrustReport?>(null, a.address) { while (true) { value = trustApi.get(a.address) ?: value; delay(6_000) } }
                    val takes by produceState(c.episodes.list()) { while (true) { value = c.episodes.list(); delay(1_500) } }
                    val reviews by produceState<com.wrk.app.roles.ReviewHistory?>(null, activeRole) { if (activeRole == Role.Verifier) while (true) { value = runCatching { reviewApi.history() }.getOrNull() ?: value; delay(8_000) } }
                    val tasks by produceState<List<BuyerBounty>?>(null, activeRole) { if (activeRole == Role.Buyer) while (true) { value = runCatching { buyerApi.summary().bounties }.getOrNull() ?: value; delay(8_000) } }
                    var name by remember(a.address) { mutableStateOf(c.accounts.displayName(a.address) ?: com.wrk.app.profile.defaultName(a)) }
                    com.wrk.app.ui.ProfileScreen(
                        account = a, role = activeRole, name = name,
                        onRename = { n -> c.accounts.setDisplayName(a.address, n); name = n.ifBlank { com.wrk.app.profile.defaultName(a) } },
                        trust = myTrust, onLiveCheck = { nav.navigate("livecheck") },
                        takes = takes, reviews = reviews, tasks = tasks,
                        onOpenTake = { nav.navigate("submission/${it.id}") },
                        onAccountSettings = { nav.navigate("account") },
                        onSignOut = signOut,
                    )
                }
            }
            composable("account") {
                PaymentAccountScreen(
                    current = account,
                    auth = auth,
                    onConnectWallet = { c.wallet.connect(sender) },
                    onSignedIn = { c.accounts.save(it); account = it; nav.popBackStack() },
                    onSignOut = signOut,
                    onBack = { nav.popBackStack() },
                    role = role,
                    onSwitchRole = { rolesProblem = null; nav.navigate("roles") },
                    phoneStatus = phone,
                )
            }
        }
        if (route != "login") Dock(
            labels = dockLabels(activeRole),
            selected = dockSelection(activeRole, route),
            onSelect = { i ->
                val dest = when (activeRole) {
                    Role.Contributor -> if (i == 0) "home" else "activity"
                    Role.Verifier -> if (i == 0) "queue" else "rhistory"
                    Role.Buyer -> if (i == 0) "dash" else "newtask"
                }
                nav.navigate(dest) { popUpTo(homeFor(activeRole)) }
            },
            onDisc = {
                when (activeRole) {
                    Role.Contributor -> bounties.firstOrNull()?.let { nav.navigate("bounty/${it.id}") { popUpTo("home") } }
                    Role.Verifier -> nav.navigate("queue") { popUpTo("queue") }
                    Role.Buyer -> nav.navigate("newtask") { popUpTo("dash") }
                }
            },
        )
    }
}
