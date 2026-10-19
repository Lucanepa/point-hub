package ch.kscw.pointhub.game.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The console's glyphs (Lucide, 24px, stroke 2; Tabler's basketball), from the same path data as
 * web/index.html, so the two screens show the same icons. Circles, lines and rects are written as
 * paths. Tinted by the Icon that draws them.
 */
object PhIcons {
    private fun circle(cx: Float, cy: Float, r: Float) =
        "M${cx - r},${cy}a$r,$r 0 1,0 ${2 * r},0a$r,$r 0 1,0 ${-2 * r},0"

    private fun rect(x: Float, y: Float, w: Float, h: Float, rx: Float) =
        "M${x + rx},${y}h${w - 2 * rx}a$rx,$rx 0 0 1 $rx,${rx}v${h - 2 * rx}a$rx,$rx 0 0 1 ${-rx},${rx}h${-(w - 2 * rx)}a$rx,$rx 0 0 1 ${-rx},${-rx}v${-(h - 2 * rx)}a$rx,$rx 0 0 1 $rx,${-rx}z"

    private fun line(x1: Float, y1: Float, x2: Float, y2: Float) = "M$x1,${y1}L$x2,$y2"

    private fun icon(name: String, vararg paths: String): ImageVector {
        val b = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        for (d in paths) {
            b.addPath(
                pathData = addPathNodes(d),
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
        return b.build()
    }

    val wifi by lazy { icon("wifi", "M12 20h.01", "M2 8.82a15 15 0 0 1 20 0", "M5 12.859a10 10 0 0 1 14 0", "M8.5 16.429a5 5 0 0 1 7 0") }
    val wifiOff by lazy {
        icon("wifi-off", "M12 20h.01", "M8.5 16.429a5 5 0 0 1 7 0", "M5 12.859a10 10 0 0 1 5.17-2.69", "M19 12.859a10 10 0 0 0-2.007-1.523",
            "M2 8.82a15 15 0 0 1 4.177-2.643", "M22 8.82a15 15 0 0 0-11.288-3.764", "m2 2 20 20")
    }
    val volleyball by lazy {
        icon("volleyball", "M11 7a16 16 20 0 1 10.98 4.362", "M12 12a13 13 0 0 1-8.66 5", "M16.83 13.634a16 16 0 0 1-9.267 7.328",
            "M20.66 17A13 13 0 0 0 12 12a13 13 0 0 1 0-10", "M8.17 15.366a16 16 0 0 1-1.713-11.69", circle(12f, 12f, 10f))
    }
    val sun by lazy {
        icon("sun", circle(12f, 12f, 4f), "M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41", "M2 12h2", "M20 12h2",
            "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41")
    }
    val basketball by lazy {
        icon("basketball", "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M5.65 5.65l12.7 12.7", "M5.65 18.35l12.7 -12.7", "M12 3a9 9 0 0 0 9 9", "M3 12a9 9 0 0 1 9 9")
    }
    val hash by lazy { icon("hash", line(4f, 9f, 20f, 9f), line(4f, 15f, 20f, 15f), line(10f, 3f, 8f, 21f), line(16f, 3f, 14f, 21f)) }
    val settings by lazy {
        icon("settings",
            "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",
            circle(12f, 12f, 3f))
    }
    val activity by lazy { icon("activity", "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2") }
    val lock by lazy { icon("lock", rect(3f, 11f, 18f, 11f, 2f), "M7 11V7a5 5 0 0 1 10 0v4") }
    val lockOpen by lazy { icon("lock-open", rect(3f, 11f, 18f, 11f, 2f), "M7 11V7a5 5 0 0 1 9.9-1") }
    val chevronLeft by lazy { icon("chevron-left", "m15 18-6-6 6-6") }
    val chevronRight by lazy { icon("chevron-right", "m9 18 6-6-6-6") }
    val timer by lazy { icon("timer", line(10f, 2f, 14f, 2f), line(12f, 14f, 15f, 11f), circle(12f, 14f, 8f)) }
    val clock by lazy { icon("clock", circle(12f, 12f, 10f), "M12 6L12 12L16 14") }
    val flag by lazy { icon("flag", "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z", line(4f, 22f, 4f, 15f)) }
    val arrowLeftRight by lazy { icon("arrow-left-right", "M8 3 4 7l4 4", "M4 7h16", "m16 21 4-4-4-4", "M20 17H4") }
    val undo by lazy { icon("undo-2", "M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11") }
    val list by lazy { icon("list", "M3 12h.01", "M3 18h.01", "M3 6h.01", "M8 12h13", "M8 18h13", "M8 6h13") }
    val delete by lazy {
        icon("delete", "M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z",
            "m12 9 6 6", "m18 9-6 6")
    }
    val globe by lazy { icon("globe", circle(12f, 12f, 10f), "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20") }
    val alert by lazy { icon("triangle-alert", "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01") }
    val x by lazy { icon("x", "M18 6 6 18", "m6 6 12 12") }
    val palette by lazy {
        icon("palette", "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z",
            circle(13.5f, 6.5f, .5f), circle(17.5f, 10.5f, .5f), circle(6.5f, 12.5f, .5f), circle(8.5f, 7.5f, .5f))
    }

    fun sport(key: String?): ImageVector = when (key) {
        "basketball" -> basketball
        "beach" -> sun
        "simple" -> hash
        else -> volleyball
    }
}
