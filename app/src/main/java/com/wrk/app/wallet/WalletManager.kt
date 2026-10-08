package com.wrk.app.wallet

import android.net.Uri
import com.funkatronics.encoders.Base58
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.Solana
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.wrk.app.account.AccountStore

sealed interface WalletResult {
    data class Connected(val address: String, val token: String? = null) : WalletResult
    data object NoWalletInstalled : WalletResult
    data class Failed(val message: String) : WalletResult
}

sealed interface SignResult {
    class Signed(val signature: ByteArray) : SignResult
    data object NoWalletInstalled : SignResult
    data class Failed(val message: String) : SignResult
}

sealed interface SignInResult {
    class Ok(val address: String, val signature: ByteArray) : SignInResult
    data object NoWalletInstalled : SignInResult
    data class Failed(val message: String) : SignInResult
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
class WalletManager(private val store: AccountStore, cluster: String = com.wrk.app.BuildConfig.SOLANA_CLUSTER) {
    private val adapter = MobileWalletAdapter(
        connectionIdentity = ConnectionIdentity(
            identityUri = Uri.parse("https://wrk.app"),
            iconUri = Uri.parse("favicon.ico"),
            identityName = "Wrk",
        ),
    ).also {
        it.authToken = store.walletAuthToken
        // Wallets send what they sign to the cluster they authorised. Wrk's escrow lives on this one.
        it.blockchain = if (cluster == "mainnet-beta") Solana.Mainnet else Solana.Devnet
    }

    private fun staleAuth(e: Throwable) =
        generateSequence(e) { it.cause }.any { it.message?.contains("authorization request failed", ignoreCase = true) == true }

    /**
     * A saved authorization can stop being valid (the wallet was reset, or it was granted for another network). The library
     * then fails instead of asking again, so forget it and ask once more from scratch.
     */
    private suspend fun <T> withFreshAuth(call: suspend () -> TransactionResult<T>): TransactionResult<T> {
        val first = call()
        if (first is TransactionResult.Failure && adapter.authToken != null && staleAuth(first.e)) {
            adapter.authToken = null
            store.walletAuthToken = null
            return call()
        }
        return first
    }

    suspend fun connect(sender: ActivityResultSender): WalletResult =
        when (val r = withFreshAuth { adapter.connect(sender) }) {
            is TransactionResult.Success -> {
                store.walletAuthToken = r.authResult.authToken
                WalletResult.Connected(Base58.encodeToString(r.authResult.accounts.first().publicKey))
            }
            is TransactionResult.NoWalletFound -> WalletResult.NoWalletInstalled
            is TransactionResult.Failure -> WalletResult.Failed(friendly(r.e))
        }

    /** Ask the wallet to sign and submit a ready-built transaction (used for the episode memo). */
    suspend fun signAndSend(sender: ActivityResultSender, tx: ByteArray): SendResult =
        withFreshAuth { adapter.transact(sender) { _ -> signAndSendTransactions(arrayOf(tx)) } }.let { r ->
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

    /**
     * Connects and proves ownership in one wallet approval: the wallet is asked once, and [challenge] is fetched from the
     * validator (for the address it just revealed) while the wallet session is still open.
     */
    suspend fun connectAndSign(sender: ActivityResultSender, challenge: suspend (address: String) -> String): SignInResult =
        withFreshAuth {
            adapter.transact(sender) { authResult ->
                val key = authResult.accounts.first().publicKey
                val address = Base58.encodeToString(key)
                runCatching {
                    val message = challenge(address)
                    val signed = signMessagesDetached(arrayOf(message.toByteArray(Charsets.UTF_8)), arrayOf(key))
                    address to checkNotNull(signed.messages.firstOrNull()?.signatures?.firstOrNull()) { "no signature returned" }
                }
            }
        }.let { r ->
            when (r) {
                is TransactionResult.Success -> {
                    store.walletAuthToken = r.authResult.authToken
                    val inner = r.payload
                    when {
                        inner == null -> SignInResult.Failed("Your wallet didn't answer. Try again.")
                        inner.isSuccess -> inner.getOrThrow().let { (a, sig) -> SignInResult.Ok(a, sig) }
                        else -> SignInResult.Failed(friendly(inner.exceptionOrNull() ?: IllegalStateException("sign-in failed")))
                    }
                }
                is TransactionResult.NoWalletFound -> SignInResult.NoWalletInstalled
                is TransactionResult.Failure -> SignInResult.Failed(friendly(r.e))
            }
        }

    /** Asks the wallet to sign a short message, proving the person holds the address. Null if they decline. */
    suspend fun signMessage(sender: ActivityResultSender, message: String): SignResult =
        withFreshAuth {
            adapter.transact(sender) { authResult ->
                signMessagesDetached(arrayOf(message.toByteArray(Charsets.UTF_8)), arrayOf(authResult.accounts.first().publicKey))
            }
        }.let { r ->
            when (r) {
                is TransactionResult.Success -> {
                    store.walletAuthToken = r.authResult.authToken
                    r.payload?.messages?.firstOrNull()?.signatures?.firstOrNull()
                        ?.let { SignResult.Signed(it) } ?: SignResult.Failed("Your wallet didn't return a signature.")
                }
                is TransactionResult.NoWalletFound -> SignResult.NoWalletInstalled
                is TransactionResult.Failure -> SignResult.Failed(friendly(r.e))
            }
        }

    suspend fun disconnect(sender: ActivityResultSender) {
        runCatching { adapter.disconnect(sender) }
        store.walletAuthToken = null
    }

    private fun friendly(e: Throwable): String {
        // The person sees a short message; the real cause goes to the log so a failure can be diagnosed.
        android.util.Log.e("WrkWallet", "wallet request failed", e)
        return friendlyMessage(e)
    }

    private fun friendlyMessage(e: Throwable): String =
        if (e is com.wrk.app.account.AuthException) (e.message ?: "Couldn't reach Wrk.")
        else if (staleAuth(e)) "Your wallet didn't approve the connection. Open it, make sure it's unlocked, and try again."
        else if (e.message?.contains("declin", ignoreCase = true) == true || e.message?.contains("cancel", ignoreCase = true) == true)
            "You didn't approve it. Try again when you're ready."
        else "Couldn't reach your payment account. Try again."
}
