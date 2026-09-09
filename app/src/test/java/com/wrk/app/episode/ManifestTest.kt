package com.wrk.app.episode

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ManifestTest {
    private val g = JSONObject(Golden.text("manifest.json"))
    private val manifest = Golden.toJson(g.get("manifest")) as JsonObj

    @Test fun hashMatchesReference() = assertEquals(g.getString("manifest_hash"), manifestHash(manifest))

    @Test fun sealIsIdempotentAndVerifies() {
        val s = seal(manifest)
        assertEquals(s, seal(s))
        assertTrue(verify(s))
    }

    @Test fun hashExcludesItself() = assertEquals(manifestHash(manifest), manifestHash(seal(manifest)))

    @Test fun tamperingBreaksVerification() {
        val s = seal(manifest)
        val t = JsonObj(s.map + ("task" to JsonStr("other")))
        assertFalse(verify(t))
    }
}
