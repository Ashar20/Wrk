package com.wrk.app.episode

import java.math.BigDecimal

/** Minimal JSON tree, just rich enough to be canonicalized byte-for-byte like the validator does. */
sealed interface Json
data class JsonObj(val map: Map<String, Json>) : Json
data class JsonArr(val items: List<Json>) : Json
data class JsonStr(val value: String) : Json
data class JsonNum(val value: Double) : Json
data class JsonBool(val value: Boolean) : Json
object JsonNull : Json

fun jsonOf(vararg pairs: Pair<String, Json>) = JsonObj(linkedMapOf(*pairs))
fun Int.json() = JsonNum(toDouble())
fun Long.json() = JsonNum(toDouble())
fun Double.json() = JsonNum(this)
fun String.json() = JsonStr(this)
fun Boolean.json() = JsonBool(this)
fun String?.jsonOrNull(): Json = if (this == null) JsonNull else JsonStr(this)
fun Double?.jsonOrNull(): Json = if (this == null) JsonNull else JsonNum(this)

/**
 * ECMAScript Number-to-String for the range the manifest uses. Values that
 * ECMAScript would render in exponent form are rejected rather than guessed at.
 */
private fun number(v: Double): String {
    require(v.isFinite()) { "Cannot canonicalize non-finite number: $v" }
    if (v == 0.0) return "0" // also normalises -0
    val abs = Math.abs(v)
    require(abs < 1e21 && abs >= 1e-6) { "Exponent form not supported: $v" }
    return BigDecimal(v.toString()).stripTrailingZeros().toPlainString()
}

private fun str(s: String): String {
    val sb = StringBuilder("\"")
    for (c in s) when {
        c == '"' -> sb.append("\\\"")
        c == '\\' -> sb.append("\\\\")
        c == '\b' -> sb.append("\\b")
        c == '\t' -> sb.append("\\t")
        c == '\n' -> sb.append("\\n")
        c == '\u000C' -> sb.append("\\f")
        c == '\r' -> sb.append("\\r")
        c < ' ' -> sb.append(String.format("\\u%04x", c.code))
        else -> sb.append(c)
    }
    return sb.append('"').toString()
}

/** RFC 8785 serialization. Kotlin's String ordering is UTF-16 code-unit order, as JCS requires. */
fun canonicalize(v: Json): String = when (v) {
    JsonNull -> "null"
    is JsonBool -> v.value.toString()
    is JsonNum -> number(v.value)
    is JsonStr -> str(v.value)
    is JsonArr -> v.items.joinToString(",", "[", "]") { canonicalize(it) }
    is JsonObj -> v.map.entries.sortedWith { a, b -> a.key.compareTo(b.key) }
        .joinToString(",", "{", "}") { "${str(it.key)}:${canonicalize(it.value)}" }
}

fun canonicalBytes(v: Json): ByteArray = canonicalize(v).toByteArray(Charsets.UTF_8)
