package com.wrk.app.episode

import org.json.JSONArray
import org.json.JSONObject

/** org.json -> the canonicalizable tree. */
fun parseJson(text: String): Json = fromAny(JSONObject(text))

private fun fromAny(v: Any?): Json = when (v) {
    null, JSONObject.NULL -> JsonNull
    is Boolean -> JsonBool(v)
    is Number -> JsonNum(v.toDouble())
    is String -> JsonStr(v)
    is JSONArray -> JsonArr(List(v.length()) { fromAny(v.get(it)) })
    is JSONObject -> JsonObj(v.keys().asSequence().associateWith { fromAny(v.get(it)) })
    else -> error("Unsupported JSON value ${v::class}")
}

/** Plain JSON text for the wire. Number formatting matches the canonical form. */
fun toJsonText(v: Json): String = canonicalize(v)
