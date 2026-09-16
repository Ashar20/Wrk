package com.wrk.app.upload

import com.funkatronics.encoders.Base58
import com.wrk.app.wallet.MemoTx
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoTxTest {
    private val signer = "9xQeWvG816bUx9EPfEZEoPqdNaE4gqCNTNqmbFnfZoxM"
    private val hash = "0x" + "ab".repeat(32)

    @Test fun memoTextMatchesWhatTheValidatorExpects() {
        assertEquals("wrk:v1:bounty_004:ep_0123456789abcdef01234567:$hash", MemoTx.text("bounty_004", "ep_0123456789abcdef01234567", hash))
    }

    @Test fun transactionCarriesSignerProgramAndMemoBytes() {
        val memo = MemoTx.text("bounty_004", "ep_0123456789abcdef01234567", hash)
        val tx = MemoTx.build(signer, "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", memo)
        fun contains(needle: ByteArray) = (0..tx.size - needle.size).any { i -> needle.indices.all { tx[i + it] == needle[it] } }
        assertTrue(contains(Base58.decode(signer)))
        assertTrue(contains(Base58.decode(MemoTx.PROGRAM)))
        assertTrue(contains(memo.toByteArray()))
        // Legacy transaction: one required signature, left empty for the wallet to fill.
        assertEquals(1, tx[0].toInt())
        assertTrue(tx.slice(1..64).all { it.toInt() == 0 })
    }
}
