package ch.kscw.pointhub.update

import java.io.InputStream
import java.security.MessageDigest

/** PURE. SHA-256 helpers with a constant-time comparison against an expected hex string. */
object Sha256 {
    fun newDigest(): MessageDigest = MessageDigest.getInstance("SHA-256")

    fun of(bytes: ByteArray): ByteArray = newDigest().digest(bytes)

    fun of(input: InputStream): ByteArray {
        val md = newDigest()
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return md.digest()
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun unhex(hex: String): ByteArray? {
        if (hex.length % 2 != 0) return null
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) {
            val hi = Character.digit(hex[2 * i], 16)
            val lo = Character.digit(hex[2 * i + 1], 16)
            if (hi < 0 || lo < 0) return null
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }

    /** Constant-time: true only when [actual] is 32 bytes and equals [expectedHex] (any case). */
    fun matches(actual: ByteArray, expectedHex: String): Boolean {
        val expected = unhex(expectedHex.trim()) ?: return false
        if (expected.size != 32 || actual.size != 32) return false
        return MessageDigest.isEqual(actual, expected)
    }
}
