package com.wrk.app.account

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AccountStoreTest {
    @Test fun emailAccountRoundTrips() {
        val s = AccountStore(MemoryKeyValue())
        val a = Account.Email("sam@example.com", "Addr1111111111111111111111111111111111111", "tok")
        s.save(a)
        assertEquals(a, s.load())
    }

    @Test fun walletAccountRoundTripsAndKeepsAuthToken() {
        val s = AccountStore(MemoryKeyValue())
        s.walletAuthToken = "mwa"
        s.save(Account.Wallet("WalletAddr"))
        assertEquals(Account.Wallet("WalletAddr"), s.load())
        assertEquals("mwa", s.walletAuthToken)
    }

    @Test fun walletSessionTokenAndRoleSurviveRestart() {
        val kv = MemoryKeyValue()
        AccountStore(kv).apply { save(Account.Wallet("W", "sess")); role = Role.Verifier }
        val back = AccountStore(kv)
        assertEquals(Account.Wallet("W", "sess"), back.load()); assertEquals("sess", back.load()!!.sessionToken); assertEquals(Role.Verifier, back.role)
    }

    @Test fun switchingAccountKeepsTheRoleButSigningOutForgetsIt() {
        val s = AccountStore(MemoryKeyValue())
        s.save(Account.Email("a@b.co", "X", "t")); s.role = Role.Buyer
        s.save(Account.Wallet("W"))
        assertEquals(Role.Buyer, s.role)
        s.clear()
        assertNull(s.role)
    }

    @Test fun switchingAccountReplacesPreviousOne() {
        val s = AccountStore(MemoryKeyValue())
        s.save(Account.Email("a@b.co", "X", "t"))
        s.save(Account.Wallet("W"))
        assertEquals(Account.Wallet("W"), s.load())
    }

    @Test fun signOutClearsEverythingIncludingWalletToken() {
        val s = AccountStore(MemoryKeyValue())
        s.walletAuthToken = "mwa"
        s.save(Account.Email("a@b.co", "X", "t"))
        s.clear()
        assertNull(s.load())
        assertNull(s.walletAuthToken)
    }

    @Test fun partialRecordLoadsAsSignedOut() {
        val kv = MemoryKeyValue(); kv.put("type", "email"); kv.put("email", "a@b.co")
        assertNull(AccountStore(kv).load())
    }
}
