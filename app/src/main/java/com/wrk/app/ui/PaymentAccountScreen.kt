package com.wrk.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wrk.app.account.Account
import com.wrk.app.account.AuthApi
import com.wrk.app.account.AuthException
import com.wrk.app.account.label
import com.wrk.app.design.ButterButton
import com.wrk.app.design.FieldCard
import com.wrk.app.design.InkButton
import com.wrk.app.design.PaperButton
import com.wrk.app.design.PaperCard
import com.wrk.app.design.Tag
import com.wrk.app.design.WrkColors
import com.wrk.app.design.WrkShape
import com.wrk.app.design.WrkTextField
import com.wrk.app.design.WrkType
import com.wrk.app.wallet.WalletResult
import kotlinx.coroutines.launch

/**
 * Where a contributor chooses how they get paid. Email is the default path (no wallet app,
 * no crypto words); an existing wallet is one tap away for people who already have one.
 */
@Composable
fun PaymentAccountScreen(
    current: Account?,
    auth: AuthApi,
    onConnectWallet: suspend () -> WalletResult,
    onSignedIn: (Account) -> Unit,
    onSignOut: () -> Unit,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
    /** First-launch sign-in: welcoming copy. */
    onboarding: Boolean = false,
    role: com.wrk.app.account.Role? = null,
    onSwitchRole: (() -> Unit)? = null,
    /** How this phone stands with the validator, e.g. "Verified". Null while unknown. */
    phoneStatus: String? = null,
) {
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var codeSent by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    fun run(block: suspend () -> Unit) {
        scope.launch {
            busy = true; problem = null
            try { block() } catch (e: AuthException) { problem = e.message } finally { busy = false }
        }
    }

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(WrkShape.gutter), verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
        if (onBack != null) PaperButton("Back", onBack)
        Text(if (onboarding) "Welcome to Wrk" else "Payment account", style = WrkType.headline.copy(fontSize = 30.sp), color = WrkColors.foreground, modifier = Modifier.padding(top = 8.dp))

        if (current != null) {
            PaperCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Tag("Payouts go to")
                    Text(current.label, style = WrkType.title, color = WrkColors.foreground)
                }
            }
            role?.let { r ->
                PaperCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { Tag("You're using Wrk as"); Text(r.label, style = WrkType.title, color = WrkColors.foreground) }
                }
            }
            phoneStatus?.let { st ->
                PaperCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Tag("This phone")
                        Text(st, style = WrkType.title, color = WrkColors.foreground)
                        Tag("A verified phone gets a bigger daily allowance and can join tasks that need one.")
                    }
                }
            }
            if (onSwitchRole != null) PaperButton("Switch role", onSwitchRole, Modifier.fillMaxWidth())
            PaperButton("Sign out", onSignOut, Modifier.fillMaxWidth())
            return@Column
        }

        Text(
            if (onboarding) "Sign in as ${role?.label?.lowercase() ?: "yourself"}. You don't need a crypto wallet."
            else "Tell us where to send what you earn. You don't need a crypto wallet.",
            style = WrkType.body, color = WrkColors.muted,
        )

        PaperCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(WrkShape.stack)) {
                Tag("Email")
                WrkTextField(email, { email = it }, "you@example.com", keyboardType = KeyboardType.Email, enabled = !codeSent && !busy)
                if (!codeSent) {
                    InkButton(if (busy) "Sending…" else "Send me a code", { run { auth.startEmail(email); codeSent = true } },
                        Modifier.fillMaxWidth(), enabled = email.contains("@") && !busy)
                } else {
                    Tag("6-digit code from your email")
                    WrkTextField(code, { code = it.filter(Char::isDigit).take(6) }, "123456", keyboardType = KeyboardType.NumberPassword, enabled = !busy)
                    InkButton(if (busy) "Checking…" else "Continue", { run { onSignedIn(auth.verifyEmail(email, code)) } },
                        Modifier.fillMaxWidth(), enabled = code.length == 6 && !busy)
                    PaperButton("Use a different email", { codeSent = false; code = ""; problem = null }, Modifier.fillMaxWidth())
                }
            }
        }

        problem?.let { FieldCard(WrkColors.butter, Modifier.fillMaxWidth()) { Text(it, style = WrkType.body, color = WrkColors.butterInk) } }

        Spacer(Modifier.height(4.dp))
        Tag("Already have a Solana wallet app?")
        PaperButton(if (onboarding) "Sign in with my wallet" else "Use my wallet", {
            scope.launch {
                busy = true; problem = null
                when (val r = onConnectWallet()) {
                    is WalletResult.Connected -> onSignedIn(Account.Wallet(r.address))
                    WalletResult.NoWalletInstalled -> problem = "No wallet app found on this phone. Use email instead, or install a Solana wallet first."
                    is WalletResult.Failed -> problem = r.message
                }
                busy = false
            }
        }, Modifier.fillMaxWidth())
    }
}
