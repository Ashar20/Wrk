package com.wrk.app.account

/** Who gets paid. Either way the contributor never sees a key, a signature prompt or a network name. */
sealed interface Account {
    val address: String

    /** Email sign-in; Wrk holds the payment account and anchors episodes for the contributor. */
    data class Email(val email: String, override val address: String, val token: String) : Account

    /** An existing wallet connected through Mobile Wallet Adapter; it signs its own anchor. */
    data class Wallet(override val address: String) : Account
}

fun shortAddress(a: String) = if (a.length <= 10) a else "${a.take(4)}…${a.takeLast(4)}"

val Account.label: String
    get() = when (this) {
        is Account.Email -> email
        is Account.Wallet -> "Wallet ${shortAddress(address)}"
    }
