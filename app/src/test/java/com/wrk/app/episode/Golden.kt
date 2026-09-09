package com.wrk.app.episode

import org.json.JSONArray
import org.json.JSONObject

object Golden {
    fun text(name: String): String =
        checkNotNull(Golden::class.java.getResourceAsStream("/golden/$name")) { "missing golden $name" }
            .bufferedReader().readText()

    fun toJson(v: Any?): Json = when (v) {
        null, JSONObject.NULL -> JsonNull
        is Boolean -> JsonBool(v)
        is Number -> JsonNum(v.toDouble())
        is String -> JsonStr(v)
        is JSONArray -> JsonArr(List(v.length()) { toJson(v.get(it)) })
        is JSONObject -> JsonObj(v.keys().asSequence().associateWith { toJson(v.get(it)) })
        else -> error("unsupported ${v::class}")
    }
}
