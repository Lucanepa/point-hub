package ch.kscw.pointhub.kiosk

/**
 * PURE. The hidden admin gesture: [taps] touch-downs inside the top-left [cornerPx] square within
 * [windowMs] (sliding window). Taps elsewhere are ignored; the window resets after a trigger.
 */
class CornerTapDetector(
    private val taps: Int = 5,
    private val windowMs: Long = 3000,
) {
    private val times = ArrayDeque<Long>()

    /** Returns true exactly when this down completes the gesture. */
    fun onDown(x: Float, y: Float, timeMs: Long, cornerPx: Float): Boolean {
        if (x < 0 || y < 0 || x >= cornerPx || y >= cornerPx) return false
        times.addLast(timeMs)
        while (times.isNotEmpty() && timeMs - times.first() > windowMs) times.removeFirst()
        if (times.size >= taps) {
            times.clear()
            return true
        }
        return false
    }

    fun reset() = times.clear()
}
