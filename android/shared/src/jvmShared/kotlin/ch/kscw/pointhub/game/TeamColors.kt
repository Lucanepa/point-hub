package ch.kscw.pointhub.game

import kotlin.math.pow
import kotlin.math.roundToInt

/*
 * PURE. Team colours on the cards, ported from web/index.html (inkOn / panelFor / hexLum /
 * teamText / toneOf). Colours are 0xRRGGBB ints; parse() refuses anything but #rrggbb, the same
 * shape the board enforces, so a colour off the wire never reaches the screen unchecked.
 */
object TeamColors {
    private val HEX = Regex("^#?[0-9a-fA-F]{6}$")

    fun parse(hex: String?): Int? {
        val h = hex?.trim() ?: return null
        if (!HEX.matches(h)) return null
        return h.removePrefix("#").toInt(16)
    }

    fun hex(rgb: Int): String = "#" + (rgb and 0xFFFFFF).toString(16).padStart(6, '0')

    private fun r(c: Int) = (c shr 16) and 0xFF
    private fun g(c: Int) = (c shr 8) and 0xFF
    private fun b(c: Int) = c and 0xFF

    const val INK_DARK = 0x111318
    const val INK_LIGHT = 0xFFFFFF

    /** Readable text on a team colour: dark ink on a light colour, white on a dark one. */
    fun inkOn(rgb: Int?): Int {
        if (rgb == null) return INK_LIGHT
        return if (0.299 * r(rgb) + 0.587 * g(rgb) + 0.114 * b(rgb) > 150) INK_DARK else INK_LIGHT
    }

    private fun lin(v: Int): Double {
        val x = v / 255.0
        return if (x <= 0.03928) x / 12.92 else ((x + 0.055) / 1.055).pow(2.4)
    }

    /** WCAG relative luminance. */
    fun lum(rgb: Int): Double = 0.2126 * lin(r(rgb)) + 0.7152 * lin(g(rgb)) + 0.0722 * lin(b(rgb))

    fun hexLum(hex: String?): Double? = parse(hex)?.let { lum(it) }

    fun contrast(a: Int, b: Int): Double {
        val x = lum(a)
        val y = lum(b)
        return (maxOf(x, y) + 0.05) / (minOf(x, y) + 0.05)
    }

    fun mix(a: Int, b: Int, t: Double): Int {
        fun ch(x: Int, y: Int) = (x + (y - x) * t).roundToInt().coerceIn(0, 255)
        return (ch(r(a), r(b)) shl 16) or (ch(g(a), g(b)) shl 8) or ch(b(a), b(b))
    }

    data class Panel(val bg: Int, val ink: Int)

    private const val PANEL_MIN_CONTRAST = 4.5
    /** The stat tiles are the ink mixed 15% over the panel: the palest surface text sits on. */
    const val TILE_TINT = 0.15

    /**
     * The card colour actually painted behind the ink. A team's own colour is often too light for
     * small white text (stock red gives 3.8:1), so the panel is shaded towards black under white
     * ink, towards white under dark ink, just far enough for the ink to clear 4.5:1 on the tiles.
     * The mirror and the board keep the exact colour: that is what the shirts are.
     */
    fun panelFor(hex: String?): Panel? {
        val rgb = parse(hex) ?: return null
        val ink = inkOn(rgb)
        val away = if (ink == INK_LIGHT) 0x000000 else 0xFFFFFF
        var bg = rgb
        var t = 0.0
        while (t <= 0.9 + 1e-9) {
            bg = mix(rgb, away, t)
            if (contrast(ink, mix(bg, ink, TILE_TINT)) >= PANEL_MIN_CONTRAST) break
            t += 0.05
        }
        return Panel(bg, ink)
    }

    /**
     * A team colour used as TEXT on a card (the result, the beach serve player). On the dark theme
     * it is lifted towards white until it reads at 4.5:1 on [card]; elsewhere it is as it is.
     */
    fun teamText(hex: String?, card: Int, dark: Boolean): Int? {
        val rgb = parse(hex) ?: return null
        if (!dark) return rgb
        var t = 0.0
        while (t <= 1.0001) {
            val c = mix(rgb, 0xFFFFFF, t)
            if (contrast(c, card) >= 4.5) return c
            t += 0.05
        }
        return 0xFFFFFF
    }

    /**
     * E-ink has no hue to tell the teams apart, so the team in the darker colour gets the ink card
     * and the other the paper card. Equal or missing colours: the panel's left half inks.
     * Returns true for "ink".
     */
    fun inkCard(panelSide: String, s: Sides?): Boolean {
        val me = panelSide
        val other = Rules.other(me)
        val a = s?.team(me)?.color?.let { hexLum(it) }
        val b = s?.team(other)?.color?.let { hexLum(it) }
        if (a == null || b == null || a == b) return me == "left"
        return a < b
    }

    /** The preset swatches the console offers (tap-friendly; a free picker is fiddly on a tablet). */
    val PRESETS = listOf(
        "#ef4444", "#f97316", "#f59e0b", "#eab308", "#22c55e", "#14b8a6",
        "#0ea5e9", "#3b82f6", "#2563eb", "#6366f1", "#a855f7", "#ec4899",
        "#ffffff", "#111827",
    )
}
