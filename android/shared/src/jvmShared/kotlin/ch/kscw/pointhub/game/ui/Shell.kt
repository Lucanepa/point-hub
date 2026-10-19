package ch.kscw.pointhub.game.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.kscw.pointhub.game.GameController
import ch.kscw.pointhub.game.Rules
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The app's tabs. Game is native; the others are the console's own, embedded under this header. */
enum class Tab(val key: String, val label: String) {
    GAME("game", "Game"),
    LINK("link", "Link"),
    HISTORY("history", "History"),
    DIAG("diag", "Diagnostics"),
    SETTINGS("settings", "Settings");

    companion object {
        fun of(key: String?): Tab? = entries.firstOrNull { it.key == key }
    }
}

/**
 * The header (web/index.html `.topbar`): the mark, the board's state in words, the set chip, where a
 * linked score comes from, the hall Wi-Fi chip, the sport badge and the tabs. While the controller
 * is unreachable or the panel is off, the `#offline` banner lies OVER it — never in the flow, so the
 * scoreboard does not jump under the scorer's thumb.
 */
@Composable
fun ShellHeader(g: GameController, tab: Tab, onTab: (Tab) -> Unit, onUplink: () -> Unit) {
    val c = Ph.colors
    Box(Modifier.fillMaxWidth().background(c.bg)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            BrandMark()
            Text("Point Hub", color = c.fg, fontSize = 15.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
            BoardDot(g)
            Row(
                Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                SetChip(g)
                ModeTag(g)
                UplinkChip(g, tab, onUplink)
            }
            SportBadge(g)
            TabButton("Game", tab == Tab.GAME) { onTab(Tab.GAME) }
            TabButton("Link", tab == Tab.LINK) { onTab(Tab.LINK) }
            TabButton("History", tab == Tab.HISTORY) { onTab(Tab.HISTORY) }
            TabIcon(PhIcons.activity, "Diagnostics", tab == Tab.DIAG) { onTab(Tab.DIAG) }
            if (g.pinRequired) {
                val open = g.scorerPin.isEmpty()
                TabIcon(
                    if (open) PhIcons.lock else PhIcons.lockOpen,
                    if (open) "Scoring locked — tap to enter PIN" else "Scoring unlocked — tap to lock this device",
                    false, gold = open,
                ) { g.lockButton() }
            }
            TabIcon(PhIcons.settings, "Settings", tab == Tab.SETTINGS) { onTab(Tab.SETTINGS) }
        }
        OfflineBanner(g, Modifier.matchParentSize())
    }
}

/** The Point Hub mark (web/favicon.svg): a gold point in a segmented ring, on its own dark tile. */
@Composable
fun BrandMark(size: androidx.compose.ui.unit.Dp = 20.dp) {
    Canvas(Modifier.size(size).semantics { contentDescription = "" }) {
        val u = this.size.width / 32f
        drawRoundRect(Color(0xFF111827), cornerRadius = CornerRadius(7.5f * u))
        drawCircle(
            Color(0xFFFFC832).copy(alpha = 0.62f), radius = 10f * u,
            style = Stroke(2.6f * u, cap = StrokeCap.Round, pathEffect = PathEffect.dashPathEffect(floatArrayOf(14f * u, 6.6f * u), 3f * u)),
        )
        drawCircle(Color(0xFFFFC832), radius = 5.2f * u, center = Offset(16f * u, 16f * u))
    }
}

@Composable
private fun BoardDot(g: GameController) {
    val c = Ph.colors
    val connected = g.reachable && g.status.ledboxConnected
    val known = g.status.json.has("ledbox") || !g.reachable
    val col = if (!known) c.muted else if (connected) c.ok else c.bad
    val title = when {
        !g.reachable -> "Not connected to the scoreboard controller"
        connected -> "LedBox connected (${g.status.ledboxHost}:${g.status.ledboxPort})"
        else -> "LedBox not connected"
    }
    Row(
        Modifier.semantics { contentDescription = title },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(if (connected) PhIcons.wifi else PhIcons.wifiOff, null, Modifier.size(17.dp), tint = col)
        Text(if (!known) "Board …" else if (connected) "Board ✓" else "Board ✗", color = col, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
    }
}

/** The set (or period) — what a scorer glances up for, so the biggest thing in the header. */
@Composable
private fun SetChip(g: GameController) {
    val c = Ph.colors
    val label = Rules.setLabel(g.sport, g.state, g.settings.bestOf)
    if (label.isEmpty()) return
    val final = g.matchOverNow && g.lastFinal != null
    val col = if (final) c.gold else c.fg
    Box(
        Modifier
            .heightIn(min = 34.dp)
            .border(Ph.hairline, if (final) c.gold else c.line, PhShape)
            .background(c.card, PhShape)
            .then(if (final) Modifier.clickable(onClickLabel = "Show the match result") { g.showMatchEnd() } else Modifier)
            .padding(horizontal = 12.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = col, fontSize = 18.sp, style = MonoStyle, maxLines = 1) }
}

/** Only a LINKED match says where its score comes from. */
@Composable
private fun ModeTag(g: GameController) {
    val c = Ph.colors
    val mode = g.status.mode ?: return
    if (mode == "manual" || mode == "idle") return
    val name = when (mode) { "lan" -> "Live (LAN)"; "cloud" -> "Cloud"; else -> mode.replaceFirstChar { it.uppercase() } }
    val match = g.status.matchId?.let { " · match $it" } ?: ""
    Box(
        Modifier.border(Ph.hairline, c.blue, RoundedCornerShapeOf4).padding(horizontal = 9.dp, vertical = 3.dp),
    ) { Text(name + match, color = c.blue, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

private val RoundedCornerShapeOf4 = androidx.compose.foundation.shape.RoundedCornerShape(4.dp)

private const val UPLINK_SOON_MS = 60 * 60 * 1000L

/** "17:30", "tomorrow 17:30", or "Sat 26.09. 17:30", in the hall's time (`uplinkUntil`). */
fun uplinkUntil(iso: String?, now: Long = System.currentTimeMillis()): String {
    val t = try { Instant.parse(iso ?: return "") } catch (_: Exception) { return "" }
    val zone = ZoneId.of("Europe/Zurich")
    val a = t.atZone(zone)
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val hm = a.format(DateTimeFormatter.ofPattern("HH:mm"))
    return when (a.toLocalDate()) {
        today -> hm
        today.plusDays(1) -> "tomorrow $hm"
        else -> a.format(DateTimeFormatter.ofPattern("EEE dd.MM. ", Locale.ENGLISH)) + hm
    }
}

fun uplinkSoon(status: String?, validUntil: String?, now: Long = System.currentTimeMillis()): Boolean {
    if (status != "online" || validUntil == null) return false
    val t = try { Instant.parse(validUntil).toEpochMilli() } catch (_: Exception) { return false }
    return t - now < UPLINK_SOON_MS
}

/**
 * The hall Wi-Fi chip: shown when the login runs out within the hour, or when the board is logged
 * out and the Game-tab banner is not there to say so (another tab, or the banner dismissed).
 */
@Composable
private fun UplinkChip(g: GameController, tab: Tab, onUplink: () -> Unit) {
    val c = Ph.colors
    val st = g.status.uplinkStatus
    val portal = st == "portal"
    val soon = uplinkSoon(st, g.status.uplinkValidUntil, g.nowMs)
    val show = soon || (portal && (tab != Tab.GAME || g.uplinkBannerDismissed))
    if (!show) return
    val text = if (portal) "Wi-Fi Log in" else "Wi-Fi until " + uplinkUntil(g.status.uplinkValidUntil, g.nowMs)
    PhButton(
        onUplink, border = if (portal) c.bad else c.line, fg = if (portal) c.bad else c.muted,
        contentPadding = PaddingValues(horizontal = 10.dp),
        label = if (portal) "The hall Wi-Fi has logged the board out — tap to log in" else "The hall Wi-Fi login runs out soon — tap to log in again",
    ) { col ->
        Icon(PhIcons.globe, null, Modifier.size(15.dp), tint = col)
        Text(text, color = col, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
    }
}

@Composable
private fun SportBadge(g: GameController) {
    val c = Ph.colors
    PhButton({ g.openSportPicker() }, fg = c.blue, contentPadding = PaddingValues(horizontal = 12.dp), label = "Change sport") { col ->
        Icon(PhIcons.sport(g.curSport), null, Modifier.size(17.dp), tint = col)
        Text(g.sportLabel(g.curSport), color = col, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
    }
}

@Composable
private fun TabButton(text: String, active: Boolean, onClick: () -> Unit) {
    val c = Ph.colors
    PhButton(
        onClick,
        border = if (active) c.fg else c.line,
        fg = if (active) c.blue else c.muted,
        borderWidth = if (active && c.eink) 3.dp else Ph.hairline,
        contentPadding = PaddingValues(horizontal = 15.dp),
    ) { col -> Text(text, color = col, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1) }
}

@Composable
private fun TabIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, active: Boolean, gold: Boolean = false, onClick: () -> Unit) {
    val c = Ph.colors
    PhButton(
        onClick,
        border = if (active) c.fg else c.line,
        fg = if (active) c.blue else if (gold) c.gold else c.muted,
        borderWidth = if (active && c.eink) 3.dp else Ph.hairline,
        contentPadding = PaddingValues(horizontal = 12.dp),
        label = label,
    ) { col -> Icon(icon, null, Modifier.size(18.dp), tint = col) }
}

/**
 * `#offline`: the controller unreachable ("taps are not reaching the board", not dismissable — it
 * goes by itself when the link is back), or the panel itself not connected (scores are still being
 * recorded; dismissable for this outage).
 */
@Composable
private fun OfflineBanner(g: GameController, modifier: Modifier) {
    val c = Ph.colors
    val unreachable = !g.reachable
    val panelOff = g.reachable && g.status.json.has("ledbox") && !g.status.ledboxConnected && !g.offlineDismissed
    if (!unreachable && !panelOff) return
    val big = if (unreachable) "Not connected — taps are not reaching the board" else "Board not connected"
    val sub = if (unreachable) {
        if (g.lastGoodAt > 0) "Frozen at " + java.text.SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(java.util.Date(g.lastGoodAt)) +
            ". Retrying on its own — check the tablet is on the board's Wi-Fi."
        else "The controller has not answered yet. Retrying on its own — check the tablet is on the board's Wi-Fi."
    } else {
        g.status.ledboxHost?.let { "Scores are still being recorded. Retrying $it… check the board is on and the cable is in." }
            ?: "Scores are still being recorded — the panel is not updating."
    }
    Column(modifier.background(c.card)) {
        Row(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp).semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(PhIcons.alert, null, Modifier.size(20.dp), tint = c.bad)
            Column(Modifier.weight(1f)) {
                Text(big, color = c.bad, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(sub, color = c.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (!unreachable) {
                PhButton({ g.offlineDismissed = true }, border = c.lineSoft, label = "Hide this notice") { col ->
                    Icon(PhIcons.x, null, Modifier.size(16.dp), tint = c.muted)
                }
            }
        }
        Box(Modifier.fillMaxWidth().defaultMinSize(minHeight = 2.dp).background(c.bad))
    }
}
