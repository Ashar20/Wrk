package com.wrk.app.profile

import com.wrk.app.account.Account
import com.wrk.app.account.AccountStore
import com.wrk.app.account.MemoryKeyValue
import com.wrk.app.episode.EpisodeState
import com.wrk.app.episode.EpisodeStatus
import com.wrk.app.episode.StoredEpisode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

class ProfileLogicTest {
    private fun take(status: EpisodeStatus, paid: Double = 0.0, id: String = status.name + paid) =
        StoredEpisode(id, File("x"), EpisodeState(status, "b", "Cup", 0.6, 1, paidUsd = paid))

    @Test fun anEmptyProfileHasNoAcceptanceRateYet() {
        val s = ProfileStats.from(emptyList())
        assertEquals(ProfileStats(0, 0, 0, 0, 0.0, null), s)
    }

    @Test fun statsCountEachKindOfTakeAndAddUpOnlyWhatWasPaid() {
        val s = ProfileStats.from(listOf(
            take(EpisodeStatus.Paid, 0.6, "a"), take(EpisodeStatus.Paid, 0.9, "b"), take(EpisodeStatus.Accepted, id = "c"),
            take(EpisodeStatus.Rejected, id = "d"), take(EpisodeStatus.Validating, id = "e"), take(EpisodeStatus.InReview, id = "f"), take(EpisodeStatus.NotSubmitted, id = "g"),
        ))
        assertEquals(7, s.takes); assertEquals(3, s.accepted); assertEquals(1, s.refused); assertEquals(3, s.inProgress)
        assertEquals(1.5, s.earnedUsd, 1e-9) // the accepted-but-unpaid one isn't earned yet
        assertEquals(75, s.acceptancePercent) // 3 of the 4 that were decided
    }

    @Test fun takesStillInProgressDontCountAgainstAcceptance() {
        assertNull(ProfileStats.from(listOf(take(EpisodeStatus.Validating, id = "a"))).acceptancePercent)
        assertEquals(100, ProfileStats.from(listOf(take(EpisodeStatus.Paid, 0.5, "a"), take(EpisodeStatus.Validating, id = "b"))).acceptancePercent)
    }

    @Test fun defaultNamesAreFriendly() {
        assertEquals("Sam Jones", defaultName(Account.Email("sam.jones@example.com", "A", "t")))
        assertEquals("Maria Del Carmen", defaultName(Account.Email("maria_del-carmen@x.co", "A", "t")))
        assertEquals("Sam", defaultName(Account.Email("SAM@x.co", "A", "t")))
        assertEquals("Wallet 9xQe…ZoxM", defaultName(Account.Wallet("9xQeWvG816bUx9EPfEZEoPqdNaE4gqCNTNqmbFnfZoxM")))
    }

    @Test fun anEmailThatIsAllPunctuationStillGetsAName() {
        assertEquals("...@x.co", defaultName(Account.Email("...@x.co", "A", "t")))
    }

    @Test fun initialsAreOneOrTwoLettersAndNeverBlank() {
        assertEquals("SJ", initials("Sam Jones")); assertEquals("SJ", initials("sam   van  jones")); assertEquals("SA", initials("Sam"))
        assertEquals("W", initials("Wallet").take(1)); assertEquals("?", initials("   ")); assertEquals("?", initials("…"))
        assertEquals("9", initials("9").take(1))
    }

    @Test fun namesAreTidiedAndLimited() {
        assertEquals("Sam Jones", cleanName("  Sam    Jones \n"))
        assertEquals(40, cleanName("x".repeat(100)).length)
        assertEquals("", cleanName("   "))
    }

    @Test fun eachAccountKeepsItsOwnName() {
        val store = AccountStore(MemoryKeyValue())
        store.setDisplayName("A", "Sam"); store.setDisplayName("B", "Priya")
        assertEquals("Sam", store.displayName("A")); assertEquals("Priya", store.displayName("B"))
        store.save(Account.Wallet("B")); // switching to another account...
        assertEquals("Priya", store.displayName("B")); assertEquals("Sam", store.displayName("A")) // ...doesn't mix names up
        assertNull(store.displayName("C"))
    }

    @Test fun clearingANameFallsBackToTheDefault() {
        val store = AccountStore(MemoryKeyValue())
        store.setDisplayName("A", "Sam"); store.setDisplayName("A", "  "); assertNull(store.displayName("A"))
    }
}
