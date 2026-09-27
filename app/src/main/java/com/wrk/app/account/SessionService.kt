package com.wrk.app.account

import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.wrk.app.wallet.SignResult
import com.wrk.app.wallet.WalletManager

/**
 * Turns "I hold this wallet" into a session the validator trusts, by having the wallet sign a one-time
 * message. Only needed for Verifier and Buyer, where the validator must know who is acting.
 */
class SessionService(private val auth: AuthApi, private val wallet: WalletManager) {
    suspend fun walletToken(sender: ActivityResultSender, address: String): String {
        val message = auth.walletChallenge(address)
        return when (val s = wallet.signMessage(sender, message)) {
            is SignResult.Signed -> auth.walletVerify(address, s.signature)
            SignResult.NoWalletInstalled -> throw AuthException("Your wallet app isn't available. Open it once, then try again.")
            is SignResult.Failed -> throw AuthException(s.message)
        }
    }
}
