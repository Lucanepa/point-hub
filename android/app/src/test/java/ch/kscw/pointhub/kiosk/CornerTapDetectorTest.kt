package ch.kscw.pointhub.kiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CornerTapDetectorTest {
    private val corner = 80f

    private fun taps(d: CornerTapDetector, times: List<Long>, x: Float = 10f, y: Float = 10f) =
        times.map { d.onDown(x, y, it, corner) }

    @Test fun fiveWithinWindowTriggers() {
        val r = taps(CornerTapDetector(), listOf(0, 700, 1400, 2100, 2900))
        assertEquals(listOf(false, false, false, false, true), r)
    }

    @Test fun fiveOverWindowDoesNot() {
        val r = taps(CornerTapDetector(), listOf(0, 800, 1600, 2400, 3100))
        assertFalse(r.last())
    }

    @Test fun slidingWindow() {
        val d = CornerTapDetector()
        val r = taps(d, listOf(0, 800, 1600, 2400, 3100, 3200))
        assertTrue(r.last()) // 800..3200 = 5 taps within 2.4 s
    }

    @Test fun outsideCornerIgnored() {
        val d = CornerTapDetector()
        taps(d, listOf(0, 100, 200, 300))
        assertFalse(d.onDown(500f, 10f, 400, corner))
        assertFalse(d.onDown(10f, 80f, 450, corner))
        assertTrue(d.onDown(79f, 79f, 500, corner))
    }

    @Test fun resetsAfterTrigger() {
        val d = CornerTapDetector()
        assertTrue(taps(d, listOf(0, 100, 200, 300, 400)).last())
        assertEquals(listOf(false, false, false, false), taps(d, listOf(500, 600, 700, 800)))
        assertTrue(d.onDown(1f, 1f, 900, corner))
    }
}
