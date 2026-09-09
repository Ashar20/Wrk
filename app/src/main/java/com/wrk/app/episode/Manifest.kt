package com.wrk.app.episode

import java.io.File
import java.io.InputStream
import java.security.MessageDigest

const val SCHEMA_VERSION = "0.2.0"
const val HASH_FIELD = "manifest_hash"

private fun toHex(bytes: ByteArray): String {
    val sb = StringBuilder("0x")
    for (b in bytes) sb.append("%02x".format(b))
    return sb.toString()
}

fun sha256Hex(bytes: ByteArray): String = toHex(MessageDigest.getInstance("SHA-256").digest(bytes))

/** Streams so a multi-megabyte recording is never held in memory. */
fun sha256Hex(input: InputStream): String {
    val md = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(8192)
    while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
    }
    return toHex(md.digest())
}

fun sha256Hex(file: File): String = file.inputStream().use { sha256Hex(it) }

private fun preimage(m: JsonObj) = JsonObj(m.map - HASH_FIELD)

fun manifestHash(m: JsonObj): String = sha256Hex(canonicalBytes(preimage(m)))

fun seal(m: JsonObj): JsonObj = JsonObj(m.map + (HASH_FIELD to JsonStr(manifestHash(m))))

fun verify(m: JsonObj): Boolean {
    val claimed = (m.map[HASH_FIELD] as? JsonStr)?.value
        ?: throw IllegalArgumentException("Manifest carries no $HASH_FIELD.")
    return manifestHash(m) == claimed
}
