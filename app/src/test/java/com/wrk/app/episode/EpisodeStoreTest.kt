package com.wrk.app.episode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class EpisodeStoreTest {
    @get:Rule val tmp = TemporaryFolder()
    private fun st(at: Long, status: EpisodeStatus = EpisodeStatus.NotSubmitted, paid: Double = 0.0) =
        EpisodeState(status, "b", "Cup", 0.6, at, paidUsd = paid)

    @Test fun survivesRestartAndKeepsNewestFirst() {
        val root = tmp.newFolder()
        EpisodeStore(root).apply { begin("a"); write("a", st(1)); begin("b"); write("b", st(2)) }
        assertEquals(listOf("b", "a"), EpisodeStore(root).list().map { it.id })
    }

    @Test fun updatesPersist() {
        val s = EpisodeStore(tmp.newFolder()); s.begin("a"); s.write("a", st(1))
        s.update("a") { it.copy(status = EpisodeStatus.Validating, anchorSignature = "sig", reasons = listOf("x")) }
        val back = s.state("a")!!
        assertEquals(EpisodeStatus.Validating, back.status); assertEquals("sig", back.anchorSignature); assertEquals(listOf("x"), back.reasons)
    }

    @Test fun earningsCountOnlyPaidEpisodes() {
        val s = EpisodeStore(tmp.newFolder())
        listOf("a" to st(1, EpisodeStatus.Paid, 0.6), "b" to st(2, EpisodeStatus.Accepted, 0.6), "c" to st(3, EpisodeStatus.Paid, 0.5)).forEach { (id, x) -> s.begin(id); s.write(id, x) }
        assertEquals(1.1, s.earnedUsd, 1e-9)
    }

    @Test fun corruptStateIsSkippedNotFatal() {
        val root = tmp.newFolder(); val s = EpisodeStore(root)
        s.begin("good"); s.write("good", st(1)); s.begin("bad"); java.io.File(s.dir("bad"), "state.json").writeText("{not json")
        assertEquals(listOf("good"), s.list().map { it.id })
    }

    @Test fun deleteRemovesTheFolder() {
        val s = EpisodeStore(tmp.newFolder()); s.begin("a"); s.write("a", st(1)); s.delete("a")
        assertNull(s.state("a")); assertEquals(0, s.list().size)
    }
}
