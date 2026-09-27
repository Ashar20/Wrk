package com.wrk.app.roles

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RolesApiTest {
    private fun api(s: MockWebServer, token: String? = "tok") = JsonApi(s.url("/").toString().trimEnd('/'), { token })

    @Test fun budgetMatchesTheValidatorsMaths() {
        assertEquals(Budget(100.0, 60.0, 30.0, 5.0, 5.0), budgetFor(0.6, 100))
        val b = budgetFor(0.37, 13)
        assertEquals(b.totalUsd, b.takesUsd + b.utilityUsd + b.validatorsUsd + b.treasuryUsd, 0.0051)
        assertEquals(25.0, budgetFor(0.75, 20).totalUsd, 0.0)
    }

    @Test fun queueParsesTheChecksAndSendsTheSession() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"items":[{"episode_id":"ep_1","bounty_title":"Cup","task_spec":"Do it","duration_s":15.2,
                "plausibility":0.62,"framing":0.5,"hands_visible_percent":56.1,"flow_gyro_corr":0.62,"per_episode_usdc":0.9,"fee_usdc":0.05}]}"""))
            val q = ReviewApi(api(s)).queue()
            assertEquals(1, q.size)
            assertEquals(0.62, q[0].plausibility!!, 0.0); assertEquals(0.05, q[0].feeUsd, 0.0); assertEquals("Cup", q[0].bountyTitle)
            val sent = s.takeRequest()
            assertEquals("Bearer tok", sent.getHeader("Authorization")); assertEquals("/review/queue", sent.path)
        }
    }

    @Test fun missingNumbersStayMissingRatherThanZero() = runTest {
        val i = parseReviewItem(JSONObject("""{"episode_id":"e","bounty_title":"t","plausibility":null,"per_episode_usdc":1,"fee_usdc":0.05}"""))
        assertEquals(null, i.plausibility); assertEquals(null, i.framing)
    }

    @Test fun decidingReportsTheFeeAndSendsTheNote() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"decision":"approved","fee":{"amount_usdc":0.05,"signature":"x"}}"""))
            assertEquals(0.05, ReviewApi(api(s)).decide("ep_1", true, "looks real"), 0.0)
            val body = JSONObject(s.takeRequest().body.readUtf8())
            assertEquals("approve", body.getString("decision")); assertEquals("looks real", body.getString("note"))
        }
    }

    @Test fun aFeeThatFailedToSendIsNotCountedAsEarned() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"decision":"rejected","fee":{"amount_usdc":0.05,"error":"treasury empty"}}"""))
            assertEquals(0.0, ReviewApi(api(s)).decide("ep_1", false, ""), 0.0)
        }
    }

    @Test fun someoneElseDecidingFirstIsExplainedNotCrashed() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"This take has already been reviewed."}"""))
            val e = runCatching { ReviewApi(api(s)).decide("ep_1", true, "") }.exceptionOrNull() as ApiException
            assertEquals("This take has already been reviewed.", e.message); assertEquals(409, e.status)
        }
    }

    @Test fun expiredSessionIsRecognisedAsSignedOut() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Sign in first."}"""))
            assertTrue((runCatching { ReviewApi(api(s)).queue() }.exceptionOrNull() as ApiException).signedOut)
        }
    }

    @Test fun unreachableServerGivesAReadableMessage() = runTest {
        val e = runCatching { ReviewApi(JsonApi("http://127.0.0.1:1", { "t" })).queue() }.exceptionOrNull() as ApiException
        assertTrue(e.message!!.contains("Can't reach Wrk")); assertFalse(e.signedOut)
    }

    @Test fun historySumsWhatWasEarned() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"earned_usdc":0.1,"items":[{"episode_id":"a","bounty_title":"Cup","decision":"approved","decided_at":5,"fee_usdc":0.05},
                {"episode_id":"b","bounty_title":"Cup","decision":"rejected","decided_at":4,"fee_usdc":0.05}]}"""))
            val h = ReviewApi(api(s)).history()
            assertEquals(0.1, h.earnedUsd, 0.0); assertEquals(listOf(true, false), h.items.map { it.approved })
        }
    }

    @Test fun buyerSummaryParsesCountsSpendAndHistogram() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"total_spend_usdc":3,"bounties":[{"bounty_id":"b1","title":"Fold","status":"open","owner_is_you":true,
                "per_episode_usdc":1,"min_episodes":5,"budget_usdc":8.33,"review_policy":"borderline","accepted":3,"rejected":1,"in_review":1,"scoring":0,
                "spend_usdc":3,"avg_plausibility":0.71,"histogram":[1,0,0,2,2]}]}"""))
            val b = BuyerApi(api(s)).summary()
            assertEquals(3.0, b.totalSpendUsd, 0.0)
            val x = b.bounties.single()
            assertTrue(x.humanReview && x.ownerIsYou && x.open)
            assertEquals(listOf(1, 0, 0, 2, 2), x.histogram); assertEquals(0.71, x.avgPlausibility!!, 0.0)
        }
    }

    @Test fun creatingATaskSendsTheBudgetInputsAndReturnsItsId() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(201).setBody("""{"bounty":{"bounty_id":"bounty_x1"}}"""))
            assertEquals("bounty_x1", BuyerApi(api(s)).create("Water a plant", "Water a houseplant, first-person.", 0.75, 20, true))
            val b = JSONObject(s.takeRequest().body.readUtf8())
            assertEquals(0.75, b.getDouble("per_episode_usdc"), 0.0); assertEquals(20, b.getInt("min_episodes")); assertEquals("borderline", b.getString("review_policy"))
        }
    }
}
