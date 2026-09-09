package com.wrk.app.episode

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ImuCodecTest {
    private val golden = JSONObject(Golden.text("imu.json"))
    private val stream: ImuStream = golden.getJSONObject("stream").let { s ->
        ImuStream(
            s.getDouble("startedAtEpochMs"),
            s.getJSONArray("samples").let { a ->
                List(a.length()) {
                    val o = a.getJSONObject(it)
                    fun f(k: String) = o.getDouble(k).toFloat()
                    ImuSample(f("t"), f("ax"), f("ay"), f("az"), f("rx"), f("ry"), f("rz"))
                }
            },
        )
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }

    @Test fun bytesMatchReference() {
        val bytes = encodeImuStream(stream)
        assertEquals(golden.getString("hex"), bytes.hex())
        assertEquals(golden.getString("sha256"), sha256Hex(bytes))
    }

    @Test fun roundTrips() = assertEquals(stream, decodeImuStream(encodeImuStream(stream)))

    @Test fun truncatedRejected() {
        val b = encodeImuStream(stream)
        assertThrows(IllegalArgumentException::class.java) { decodeImuStream(b.copyOf(b.size - 1)) }
    }

    @Test fun badMagicRejected() {
        val b = encodeImuStream(stream); b[0] = 'X'.code.toByte()
        assertThrows(IllegalArgumentException::class.java) { decodeImuStream(b) }
    }

    @Test fun nonFiniteRejected() {
        val bad = stream.copy(samples = listOf(stream.samples[0].copy(rx = Float.NaN)))
        assertThrows(IllegalArgumentException::class.java) { encodeImuStream(bad) }
    }

    @Test fun emptyStreamIsHeaderOnly() {
        assertEquals(IMU_HEADER_BYTES, encodeImuStream(ImuStream(0.0, emptyList())).size)
    }
}
