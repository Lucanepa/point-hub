package ch.kscw.pointhub.game.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/**
 * The console's token sets (web/index.html `:root`, `[data-theme="dark"]`, `[data-theme="eink"]`),
 * one for one, so the native Game tab and the console's other tabs read as one screen. The theme is
 * chosen in the console (Settings ▸ Theme) and reported over the bridge (setTheme).
 */
@Immutable
data class PhColors(
    val name: String,
    val bg: Color,
    val card: Color,
    val fill: Color,
    val fg: Color,
    val muted: Color,
    val line: Color,
    val lineSoft: Color,
    val blue: Color,
    val gold: Color,
    val ok: Color,
    val warn: Color,
    val bad: Color,
    val onAccent: Color,
    val scrim: Color,
) {
    val dark get() = name == "dark"
    val eink get() = name == "eink"

    companion object {
        val LIGHT = PhColors(
            "light", Color(0xFFFFFFFF), Color(0xFFFFFFFF), Color(0xFFFAFAFC), Color(0xFF0A0B0D), Color(0xFF5A606B),
            Color(0xFF111318), Color(0xFFE3E5EA), Color(0xFF0A34D6), Color(0xFFB45309),
            Color(0xFF12813F), Color(0xFFB45309), Color(0xFFE0301A), Color(0xFFFFFFFF), Color(0x520F1116),
        )
        // Dark is not black: a black page is what made "the tablet went black" read as a screen that
        // had switched itself off. A lit slate, with every card keeping a visible edge.
        val DARK = PhColors(
            "dark", Color(0xFF151A22), Color(0xFF1B212B), Color(0xFF252C38), Color(0xFFEEF1F6), Color(0xFF9AA3B1),
            Color(0xFF7F899A), Color(0xFF343C49), Color(0xFF7EA1FF), Color(0xFFF0B14A),
            Color(0xFF4FD58A), Color(0xFFF0B14A), Color(0xFFFF6F5E), Color(0xFF0B1020), Color(0x99000000),
        )
        // E-ink: greyscale for a tablet in full sun. Hue carries nothing here, so the screens use fill
        // versus outline, dashes and underlines for what colour said elsewhere.
        val EINK = PhColors(
            "eink", Color(0xFFFFFFFF), Color(0xFFFFFFFF), Color(0xFFEBEBEB), Color(0xFF000000), Color(0xFF262626),
            Color(0xFF000000), Color(0xFF5C5C5C), Color(0xFF000000), Color(0xFF000000),
            Color(0xFF000000), Color(0xFF000000), Color(0xFF000000), Color(0xFFFFFFFF), Color(0xD1FFFFFF),
        )

        fun of(theme: String?): PhColors = when (theme) {
            "dark" -> DARK
            "eink" -> EINK
            else -> LIGHT
        }
    }
}

val LocalPh = staticCompositionLocalOf { PhColors.LIGHT }

object Ph {
    /** The smallest thing a finger is asked to hit: standing, one-handed, mid-rally. */
    val tap = 44.dp
    val radius = 3.dp
    val hairline = 1.5.dp
    val mono = FontFamily.Monospace
    val colors: PhColors @Composable get() = LocalPh.current
}

@Composable
fun PhTheme(theme: String, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalPh provides PhColors.of(theme), content = content)
}

/** The LED panel's own colours: the mirror looks like the board in every theme but e-ink. */
object Led {
    val panel = Color(0xFF080A12)
    val label = Color(0xFFAEB8D8)
    val vsDash = Color(0xFFDFE6FF)
    val count = Color(0xFFE7ECFF)
    val red = Color(0xFFFF5B52)
    val amber = Color(0xFFFFBF3F)
    val foulRed = Color(0xFFFF3C28)
    val bonusOff = Color(0xFF40465E)
    val serveOff = Color(0xFF161C30)
    val switchOff = Color(0xFF3C3C3C)
    val box = Color(0xFF555555)
    val gold = Color(0xFFFFC832)
    val cdGold = Color(0xFFFFCF47)
    val sep = Color(0xFF39415F)
    val idleHome = Color(0xFFFFCF47)
    val idleGuest = Color(0xFFFF7A3D)
    val cdDash = Color(0xFF8892B0)
}

fun rgb(c: Int): Color = Color(0xFF000000.toInt() or (c and 0xFFFFFF))
