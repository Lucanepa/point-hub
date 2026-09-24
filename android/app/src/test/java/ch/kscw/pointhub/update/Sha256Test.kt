package ch.kscw.pointhub.update

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class Sha256Test {
    private val empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    private val abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

    @Test fun knownVectors() {
        assertEquals(empty, Sha256.hex(Sha256.of(ByteArray(0))))
        assertEquals(abc, Sha256.hex(Sha256.of("abc".toByteArray())))
    }

    @Test fun streamingEqualsOneShot() {
        val data = ByteArray(300_000) { (it * 31).toByte() }
        assertArrayEquals(Sha256.of(data), Sha256.of(data.inputStream()))
    }

    @Test fun matches() {
        val d = Sha256.of("abc".toByteArray())
        assertTrue(Sha256.matches(d, abc))
        assertTrue(Sha256.matches(d, abc.uppercase()))
        assertFalse(Sha256.matches(d, empty))
        assertFalse(Sha256.matches(d, abc.dropLast(2)))
        assertFalse(Sha256.matches(d, abc + "00"))
        assertFalse(Sha256.matches(d, "zz" + abc.drop(2)))
        assertFalse(Sha256.matches(d.copyOf(31), abc))
    }
}
