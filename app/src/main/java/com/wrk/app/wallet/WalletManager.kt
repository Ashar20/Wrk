package com.wrk.app.wallet

import android.net.Uri
import com.funkatronics.encoders.Base58
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.wrk.app.account.AccountStore

sealed interface WalletResult {
    data class Connected(val address: String) : WalletResult
    data object NoWalletInstalled : WalletResult
    data class Failed(val message: String) : WalletResult
}

sealed interface SendResult {
    data class Sent(val signature: String) : SendResult
    data object NoWalletInstalled : SendResult
    data class Failed(val message: String) : SendResult
}

/**
 * Existing-wallet path. Wrk never sees a key: the wallet app approves and signs, and the
 * returned auth token is kept encrypted so returning users aren't asked again.
 */
class WalletManager(private val store: AccountStore) {
    private val adapter = MobileWalletAdapter(
        connectionIdentity = ConnectionIdentity(
            identityUri = Uri.parse("https://wrk.app"),
            iconUri = Uri.parse("favicon.ico"),
            identityName = "Wrk",
        ),
    ).also { it.authToken = store.walletAuthToken }

    suspend fun connect(sender: ActivityResultSender): WalletResult =
        when (val r = adapter.connect(sender)) {
            is TransactionResult.Success -> {
                store.walletAuthToken = r.authResult.authToken
                WalletResult.Connected(Base58.encodeToString(r.authResult.accounts.first().publicKey))
            }
            is TransactionResult.NoWalletFound -> WalletResult.NoWalletInstalled
            is TransactionResult.Failure -> WalletResult.Failed(friendly(r.e))
        }

    /** Ask the wallet to sign and submit a ready-built transaction (used for the episode memo). */
    suspend fun signAndSend(sender: ActivityResultSender, tx: ByteArray): SendResult =
        adapter.transact(sender) { _ -> signAndSendTransactions(arrayOf(tx)) }.let { r ->
        when (r) {
            is TransactionResult.Success -> {
                store.walletAuthToken = r.authResult.authToken
                r.payload?.signatures?.firstOrNull()
                    ?.let { SendResult.Sent(Base58.encodeToString(it)) }
                    ?: SendResult.Failed("The payment account didn't return a receipt.")
            }
            is TransactionResult.NoWalletFound -> SendResult.NoWalletInstalled
            is TransactionResult.Failure -> SendResult.Failed(friendly(r.e))
        }
        }

    suspend fun disconnect(sender: ActivityResultSender) {
        runCatching { adapter.disconnect(sender) }
        store.walletAuthToken = null
    }

    private fun friendly(e: Throwable): String =
        if (e.message?.contains("declin", ignoreCase = true) == true || e.message?.contains("cancel", ignoreCase = true) == true)
            "You didn't approve it. Try again when you're ready."
        else "Couldn't reach your payment account. Try again."
}
