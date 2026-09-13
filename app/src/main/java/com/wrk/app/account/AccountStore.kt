package com.wrk.app.account

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

interface KeyValue {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

class MemoryKeyValue : KeyValue {
    private val m = mutableMapOf<String, String>()
    override fun get(key: String) = m[key]
    override fun put(key: String, value: String) { m[key] = value }
    override fun remove(key: String) { m.remove(key) }
}

/** Encrypted at rest; session tokens and wallet auth tokens never sit in plain preferences. */
class EncryptedKeyValue(context: Context) : KeyValue {
    private val prefs = EncryptedSharedPreferences.create(
        context, "wrk_account",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    override fun get(key: String) = prefs.getString(key, null)
    override fun put(key: String, value: String) = prefs.edit().putString(key, value).apply()
    override fun remove(key: String) = prefs.edit().remove(key).apply()
}

class AccountStore(private val kv: KeyValue) {
    fun load(): Account? = when (kv.get("type")) {
        "email" -> {
            val email = kv.get("email"); val address = kv.get("address"); val token = kv.get("token")
            if (email != null && address != null && token != null) Account.Email(email, address, token) else null
        }
        "wallet" -> kv.get("address")?.let { Account.Wallet(it) }
        else -> null
    }

    fun save(a: Account) {
        clear(keepWalletToken = true)
        when (a) {
            is Account.Email -> { kv.put("type", "email"); kv.put("email", a.email); kv.put("address", a.address); kv.put("token", a.token) }
            is Account.Wallet -> { kv.put("type", "wallet"); kv.put("address", a.address) }
        }
    }

    fun clear(keepWalletToken: Boolean = false) {
        listOf("type", "email", "address", "token").forEach(kv::remove)
        if (!keepWalletToken) kv.remove(MWA_TOKEN)
    }

    var walletAuthToken: String?
        get() = kv.get(MWA_TOKEN)
        set(v) { if (v == null) kv.remove(MWA_TOKEN) else kv.put(MWA_TOKEN, v) }

    private companion object { const val MWA_TOKEN = "mwa_auth_token" }
}
