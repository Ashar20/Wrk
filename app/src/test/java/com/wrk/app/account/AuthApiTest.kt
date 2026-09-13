package com.wrk.app.account

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthApiTest {
    private fun api(s: MockWebServer) = AuthApi(s.url("/").toString().trimEnd('/'))

    @Test fun verifyReturnsEmailAccount() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"token":"t","address":"Addr","email":"sam@example.com"}"""))
            val a = api(s).verifyEmail("Sam@Example.com", "123456")
            assertEquals(Account.Email("sam@example.com", "Addr", "t"), a)
            val sent = s.takeRequest()
            assertEquals("/auth/email/verify", sent.path)
            assertTrue(sent.body.readUtf8().contains("123456"))
        }
    }

    @Test fun serverErrorMessageIsSurfacedToTheContributor() = runTest {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"That code is not right."}"""))
            val e = runCatching { api(s).verifyEmail("a@b.co", "000000") }.exceptionOrNull()
            assertEquals("That code is not right.", e?.message)
        }
    }

    @Test fun unreachableServerGivesReadableError() = runTest {
        val e = runCatching { AuthApi("http://127.0.0.1:1").startEmail("a@b.co") }.exceptionOrNull()
        assertTrue(e is AuthException)
        assertTrue(e!!.message!!.contains("connection"))
    }
}
