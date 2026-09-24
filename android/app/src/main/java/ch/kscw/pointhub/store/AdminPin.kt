package ch.kscw.pointhub.store

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/** Where the PIN hash and lockout state live (SharedPreferences in the app, a map in tests). */
interface PinStorage {
    var pinHash: String?
    var pinSalt: String?
    var pinFailures: Int
    var pinLockedUntil: Long
}

/**
 * PURE. The app-local admin PIN (NOT the board's scorer PIN). PBKDF2-HMAC-SHA256, random salt,
 * constant-time compare, and an exponential lockout after [FREE_ATTEMPTS] wrong tries.
 */
class AdminPin(
    private val storage: PinStorage,
    private val clock: () -> Long = System::currentTimeMillis,
    private val iterations: Int = 120_000,
    private val random: SecureRandom = SecureRandom(),
) {
    companion object {
        const val DEFAULT_PIN = "2026"
        const val FREE_ATTEMPTS = 5
        const val BASE_LOCK_MS = 30_000L
        const val MAX_LOCK_MS = 10 * 60_000L

        fun isValidFormat(pin: String): Boolean = pin.length in 4..8 && pin.all { it in '0'..'9' }

        /** Lockout after the [failures]-th consecutive wrong PIN: 0 before the 5th, then 30 s x 2^(n-5), capped at 10 min. */
        fun lockoutMs(failures: Int): Long {
            if (failures < FREE_ATTEMPTS) return 0
            val shift = (failures - FREE_ATTEMPTS).coerceAtMost(20)
            return (BASE_LOCK_MS shl shift).coerceAtMost(MAX_LOCK_MS)
        }
    }

    sealed class Result {
        data object Ok : Result()
        data class Wrong(val attemptsBeforeLock: Int, val lockedForMs: Long) : Result()
        data class LockedOut(val remainingMs: Long) : Result()
    }

    val isSet: Boolean get() = storage.pinHash != null && storage.pinSalt != null

    fun set(pin: String) {
        require(isValidFormat(pin)) { "PIN must be 4 to 8 digits" }
        val salt = ByteArray(16).also { random.nextBytes(it) }
        storage.pinSalt = Base64.getEncoder().encodeToString(salt)
        storage.pinHash = Base64.getEncoder().encodeToString(hash(pin, salt))
        storage.pinFailures = 0
        storage.pinLockedUntil = 0
    }

    fun ensureDefault() {
        if (!isSet) set(DEFAULT_PIN)
    }

    fun remainingLockMs(): Long = (storage.pinLockedUntil - clock()).coerceAtLeast(0)

    fun verify(pin: String): Result {
        val remaining = remainingLockMs()
        if (remaining > 0) return Result.LockedOut(remaining)
        val salt = storage.pinSalt?.let { Base64.getDecoder().decode(it) }
        val expected = storage.pinHash?.let { Base64.getDecoder().decode(it) }
        val ok = salt != null && expected != null && isValidFormat(pin) &&
            MessageDigest.isEqual(hash(pin, salt), expected)
        if (ok) {
            storage.pinFailures = 0
            storage.pinLockedUntil = 0
            return Result.Ok
        }
        val failures = storage.pinFailures + 1
        storage.pinFailures = failures
        val lock = lockoutMs(failures)
        if (lock > 0) storage.pinLockedUntil = clock() + lock
        return Result.Wrong((FREE_ATTEMPTS - failures).coerceAtLeast(0), lock)
    }

    private fun hash(pin: String, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(pin.toCharArray(), salt, iterations, 256)
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }
}
