package com.wrk.app.device

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import com.wrk.app.account.AccountStore
import com.wrk.app.roles.ApiException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** A take's proof that it came from this phone. */
data class DeviceSignature(val deviceId: String, val signatureB64: String)

/** What the upload step needs: a signature over a take, and a way to start over if the validator forgot the phone. */
interface DeviceSigner {
    suspend fun sign(episodeId: String, manifestHash: String): DeviceSignature?
    suspend fun reset()
}

sealed interface DeviceStatus {
    /** Hardware-backed key, verified boot, and the genuine Wrk app: takes from this phone count as attested. */
    data object Verified : DeviceStatus
    /** Registered, but the validator couldn't vouch for everything (e.g. an unlocked bootloader). Takes still go through. */
    data object Limited : DeviceStatus
    /** Couldn't register right now (offline, or this phone has no secure hardware). Takes still go through, unattested. */
    data class Unavailable(val reason: String) : DeviceStatus
}

/** The exact message the validator checks a take's signature against. */
fun takeMessage(episodeId: String, manifestHash: String) = "wrk:take:v1:$episodeId:$manifestHash"

/**
 * This phone's identity as far as Wrk is concerned: an elliptic-curve key created inside the phone's secure hardware
 * (the key itself can never leave it), plus the certificate chain the hardware produced when it made the key. The
 * validator checks that chain against Google's roots, so it learns the key lives on a genuine, locked, up-to-date
 * phone and was made by this app. Each take is then signed with that key.
 *
 * None of this is secret from the person; what it prevents is somebody else claiming to be a real phone.
 */
class DeviceKey(private val store: AccountStore, private val api: DeviceApi) : DeviceSigner {
    private val lock = Mutex()

    val status: DeviceStatus?
        get() = when (store.deviceTrust) {
            "attested" -> DeviceStatus.Verified
            "heuristic" -> DeviceStatus.Limited
            else -> null
        }

    /** Registers this phone if it isn't already. Safe to call often; does nothing once done. */
    suspend fun ensureRegistered(): DeviceStatus = lock.withLock {
        if (store.deviceId != null && keyExists()) return status ?: DeviceStatus.Limited
        try {
            val challenge = api.challenge()
            val chain = generateKey(Base64.decode(challenge, Base64.DEFAULT))
            val r = api.register(challenge, chain)
            store.deviceId = r.deviceId
            store.deviceTrust = if (r.attested) "attested" else "heuristic"
            if (r.attested) DeviceStatus.Verified else DeviceStatus.Limited
        } catch (e: ApiException) {
            DeviceStatus.Unavailable(if (e.status == 400) "This phone couldn't be verified." else (e.message ?: "Couldn't verify this phone."))
        } catch (e: Exception) {
            android.util.Log.e("WrkDevice", "device registration failed", e)
            DeviceStatus.Unavailable("This phone has no secure hardware key to verify.")
        }
    }

    override suspend fun sign(episodeId: String, manifestHash: String): DeviceSignature? {
        ensureRegistered()
        val id = store.deviceId ?: return null
        val key = privateKey() ?: return null
        return try {
            val sig = Signature.getInstance("SHA256withECDSA").run {
                initSign(key)
                update(takeMessage(episodeId, manifestHash).toByteArray(Charsets.UTF_8))
                sign()
            }
            DeviceSignature(id, Base64.encodeToString(sig, Base64.NO_WRAP))
        } catch (e: Exception) {
            android.util.Log.e("WrkDevice", "signing failed", e)
            null
        }
    }

    /** The validator doesn't know this phone (its records were wiped): forget it and register again next time. */
    override suspend fun reset() = lock.withLock {
        store.deviceId = null
        store.deviceTrust = null
        runCatching { keystore().deleteEntry(ALIAS) }
        Unit
    }

    // ---- keystore ----------------------------------------------------------------------------------------------
    private fun keystore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun keyExists() = runCatching { keystore().containsAlias(ALIAS) }.getOrDefault(false)
    private fun privateKey(): PrivateKey? = runCatching { keystore().getKey(ALIAS, null) as? PrivateKey }.getOrNull()

    /** Creates the key with the validator's challenge and returns its certificate chain, leaf first, as base64 DER. */
    private fun generateKey(challenge: ByteArray): List<String> {
        runCatching { keystore().deleteEntry(ALIAS) }
        fun make(strongBox: Boolean) {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAttestationChallenge(challenge)
                .apply { if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true) }
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run { initialize(spec); generateKeyPair() }
        }
        // StrongBox is a separate secure chip some phones have; use it when there, otherwise the normal secure hardware.
        try { make(strongBox = true) } catch (e: StrongBoxUnavailableException) { make(strongBox = false) }
        val chain = keystore().getCertificateChain(ALIAS) ?: throw DeviceUnavailable("No certificate chain was produced.")
        return chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
    }

    private companion object { const val ALIAS = "wrk_device_key" }
}
