package ch.kscw.pointhub.store

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import androidx.core.content.edit
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The Wi-Fi passphrase, encrypted with an AES-256-GCM key that lives in the Android Keystore.
 * (security-crypto's EncryptedSharedPreferences is deprecated; this is the direct replacement.)
 * No user-auth requirement: the app must be able to decrypt unattended, right after boot.
 */
class SecretStore(context: Context) {
    private val sp = context.getSharedPreferences("secure", Context.MODE_PRIVATE)

    companion object {
        private const val TAG = "SecretStore"
        private const val ALIAS = "pointhub_wifi"
        private const val KEY_PASS = "wifiPass"
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(create: Boolean): SecretKey? {
        val ks = keyStore()
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        if (!create) return null
        fun gen(strongBox: Boolean): SecretKey {
            val b = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
            if (Build.VERSION.SDK_INT >= 28) {
                b.setUnlockedDeviceRequired(false)
                if (strongBox) b.setIsStrongBoxBacked(true)
            }
            val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            g.init(b.build())
            return g.generateKey()
        }
        return if (Build.VERSION.SDK_INT >= 28) {
            try {
                gen(true)
            } catch (_: StrongBoxUnavailableException) {
                gen(false)
            }
        } else gen(false)
    }

    fun setWifiPassphrase(pass: String?) {
        if (pass == null) {
            sp.edit(commit = true) { remove(KEY_PASS) }
            return
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
        val ct = cipher.doFinal(pass.toByteArray(Charsets.UTF_8))
        val v = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
        sp.edit(commit = true) { putString(KEY_PASS, v) }
    }

    /**
     * Null when unset or unreadable. The stored passphrase (and the key) are wiped ONLY when they
     * can never be read again: the key was permanently invalidated, is gone, or cannot be
     * recovered, or the ciphertext is corrupt. A transient failure (the Keystore still starting
     * right after boot, a busy StrongBox: KeyStoreException, ProviderException, …) returns null
     * and keeps both, so the next call can succeed.
     */
    fun wifiPassphrase(): String? {
        val v = sp.getString(KEY_PASS, null) ?: return null
        val parts = v.split(":", limit = 2)
        val decoded = try {
            if (parts.size != 2) null else parts.map { Base64.decode(it, Base64.NO_WRAP) }
        } catch (_: IllegalArgumentException) {
            null
        }
        if (decoded == null) {
            Log.w(TAG, "stored passphrase is malformed, wiping it")
            sp.edit(commit = true) { remove(KEY_PASS) }
            return null
        }
        val (iv, ct) = decoded
        return try {
            val ks = keyStore()
            if (!ks.containsAlias(ALIAS)) {
                Log.w(TAG, "passphrase key is gone, wiping the passphrase")
                sp.edit(commit = true) { remove(KEY_PASS) }
                return null
            }
            val k = ks.getKey(ALIAS, null) as? SecretKey ?: throw UnrecoverableKeyException("not a secret key")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (e: Exception) {
            if (isPermanent(e)) {
                Log.w(TAG, "passphrase unreadable for good, wiping: ${e.javaClass.simpleName}")
                sp.edit(commit = true) { remove(KEY_PASS) }
                try { keyStore().deleteEntry(ALIAS) } catch (_: Exception) {}
            } else {
                Log.w(TAG, "passphrase not readable right now (kept): ${e.javaClass.simpleName}")
            }
            null
        }
    }

    private fun isPermanent(e: Throwable): Boolean =
        e is KeyPermanentlyInvalidatedException || e is AEADBadTagException || e is UnrecoverableKeyException
}
