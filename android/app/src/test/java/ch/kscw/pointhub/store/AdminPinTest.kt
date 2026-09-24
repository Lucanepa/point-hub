package ch.kscw.pointhub.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdminPinTest {
    private class MemStorage : PinStorage {
        override var pinHash: String? = null
        override var pinSalt: String? = null
        override var pinFailures: Int = 0
        override var pinLockedUntil: Long = 0
    }

    private var now = 1_000_000L
    private val storage = MemStorage()
    private val pin = AdminPin(storage, { now }, iterations = 1000)

    @Test fun defaultVerifies() {
        assertFalse(pin.isSet)
        pin.ensureDefault()
        assertTrue(pin.isSet)
        assertEquals(AdminPin.Result.Ok, pin.verify("2026"))
    }

    @Test fun changePin() {
        pin.ensureDefault()
        pin.set("73519")
        assertTrue(pin.verify("2026") is AdminPin.Result.Wrong)
        assertEquals(AdminPin.Result.Ok, pin.verify("73519"))
    }

    @Test fun saltIsRandom() {
        pin.set("1234"); val h1 = storage.pinHash
        pin.set("1234"); val h2 = storage.pinHash
        assertTrue(h1 != h2)
    }

    @Test fun formatRules() {
        assertTrue(AdminPin.isValidFormat("1234"))
        assertTrue(AdminPin.isValidFormat("12345678"))
        assertFalse(AdminPin.isValidFormat("123"))
        assertFalse(AdminPin.isValidFormat("123456789"))
        assertFalse(AdminPin.isValidFormat("12a4"))
    }

    @Test fun lockoutGrowsAndCaps() {
        assertEquals(0, AdminPin.lockoutMs(4))
        assertEquals(30_000L, AdminPin.lockoutMs(5))
        assertEquals(60_000L, AdminPin.lockoutMs(6))
        assertEquals(240_000L, AdminPin.lockoutMs(8))
        assertEquals(600_000L, AdminPin.lockoutMs(10))
        assertEquals(600_000L, AdminPin.lockoutMs(60))
    }

    @Test fun lockoutProgression() {
        pin.ensureDefault()
        repeat(4) { assertEquals(0L, (pin.verify("0000") as AdminPin.Result.Wrong).lockedForMs) }
        val fifth = pin.verify("0000") as AdminPin.Result.Wrong
        assertEquals(30_000L, fifth.lockedForMs)
        // Even the right PIN is refused while locked.
        assertTrue(pin.verify("2026") is AdminPin.Result.LockedOut)
        now += 30_001
        assertEquals(60_000L, (pin.verify("0000") as AdminPin.Result.Wrong).lockedForMs)
        now += 60_001
        assertEquals(AdminPin.Result.Ok, pin.verify("2026"))
        assertEquals(0, storage.pinFailures)
    }
}
