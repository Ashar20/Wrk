package com.wrk.app.episode

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** One motion reading. `t` is ms since capture start; gyro is rad/s about device X/Y/Z. */
data class ImuSample(
    val t: Float, val ax: Float, val ay: Float, val az: Float,
    val rx: Float, val ry: Float, val rz: Float,
)

data class ImuStream(val startedAtEpochMs: Double, val samples: List<ImuSample>)

private const val MAGIC = "WMIMU1" // wire-format magic shared with the validator; not user-visible
private const val VERSION = 1
const val IMU_HEADER_BYTES = 20
const val IMU_SAMPLE_BYTES = 28

fun imuStreamByteLength(count: Int) = IMU_HEADER_BYTES + count * IMU_SAMPLE_BYTES

/** Layout (little-endian): magic[6] ver[1] rsv[1] f64 startedAt, u32 n, n * 7 * f32. */
fun encodeImuStream(s: ImuStream): ByteArray {
    require(s.startedAtEpochMs.isFinite()) { "startedAtEpochMs must be finite." }
    val buf = ByteBuffer.allocate(imuStreamByteLength(s.samples.size)).order(ByteOrder.LITTLE_ENDIAN)
    buf.put(MAGIC.toByteArray(Charsets.US_ASCII))
    buf.put(VERSION.toByte()).put(0)
    buf.putDouble(s.startedAtEpochMs)
    buf.putInt(s.samples.size)
    s.samples.forEachIndexed { i, x ->
        for ((v, label) in listOf(x.t to "t", x.ax to "ax", x.ay to "ay", x.az to "az", x.rx to "rx", x.ry to "ry", x.rz to "rz")) {
            require(v.isFinite()) { "IMU sample $i has non-finite $label" }
            buf.putFloat(v)
        }
    }
    return buf.array()
}

fun decodeImuStream(b: ByteArray): ImuStream {
    require(b.size >= IMU_HEADER_BYTES) { "IMU stream is shorter than its header." }
    val buf = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
    val magic = String(b, 0, 6, Charsets.US_ASCII)
    require(magic == MAGIC) { "Not an IMU stream: bad magic." }
    buf.position(6)
    val version = buf.get().toInt()
    require(version == VERSION) { "Unsupported IMU format version $version." }
    buf.get()
    val started = buf.getDouble()
    val n = buf.getInt()
    require(n >= 0 && b.size == imuStreamByteLength(n)) { "IMU stream is truncated or corrupt." }
    val samples = List(n) {
        ImuSample(buf.getFloat(), buf.getFloat(), buf.getFloat(), buf.getFloat(), buf.getFloat(), buf.getFloat(), buf.getFloat())
    }
    return ImuStream(started, samples)
}
