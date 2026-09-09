package com.wrk.app.episode

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class CanonicalJsonTest {
    @Test fun matchesReferenceImplementation() {
        val cases = JSONArray(Golden.text("canonical.json"))
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals("case $i", c.getString("expected"), canonicalize(Golden.toJson(c.get("input"))))
        }
    }

    @Test fun negativeZeroIsZero() = assertEquals("0", canonicalize(JsonNum(-0.0)))

    @Test fun nonFiniteRejected() {
        assertThrows(IllegalArgumentException::class.java) { canonicalize(JsonNum(Double.NaN)) }
        assertThrows(IllegalArgumentException::class.java) { canonicalize(JsonNum(Double.POSITIVE_INFINITY)) }
    }

    @Test fun exponentFormRejected() {
        assertThrows(IllegalArgumentException::class.java) { canonicalize(JsonNum(1e21)) }
        assertThrows(IllegalArgumentException::class.java) { canonicalize(JsonNum(1e-7)) }
    }
}
