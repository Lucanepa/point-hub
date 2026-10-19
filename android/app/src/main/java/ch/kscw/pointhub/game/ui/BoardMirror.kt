package ch.kscw.pointhub.game.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import ch.kscw.pointhub.R
import ch.kscw.pointhub.game.BoardMode
import ch.kscw.pointhub.game.Countdown
import ch.kscw.pointhub.game.Rules
import ch.kscw.pointhub.game.Sides
import ch.kscw.pointhub.game.Sport
import ch.kscw.pointhub.game.Team
import ch.kscw.pointhub.game.TeamColors
import java.util.Calendar
import kotlin.math.floor

/*
 * The board mirror: the LED panel as the HALL sees it (never mapped by where the scorer sits),
 * drawn from the firmware's own match layouts (192x64), as web/index.html's LAYOUTS draw it.
 * Shared geometry (names, score boxes, serve bars) is identical across sports; only the
 * sport-specific sections differ. Non-match screens follow the board: the names + VS screen, the
 * clock, a break countdown.
 */

private const val BW = 192f
private const val BH = 64f

private enum class Kind { TEXT, BOX, BAR }
private enum class Align { LEFT, CENTER, RIGHT }

private data class Sec(
    val n: String, val kind: Kind, val x: Float, val y: Float, val fs: Float = 0f,
    val a: Align = Align.LEFT, val vc: Boolean = false, val fixed: String? = null, val col: Color? = null,
    val w: Float = 0f, val h: Float = 0f,
)

private fun t(n: String, x: Float, y: Float, fs: Float, a: Align = Align.LEFT, vc: Boolean = false, fixed: String? = null, col: Color? = null) =
    Sec(n, Kind.TEXT, x, y, fs, a, vc, fixed, col)
private fun box(n: String, x: Float, y: Float, w: Float, h: Float) = Sec(n, Kind.BOX, x, y, w = w, h = h)
private fun bar(n: String, x: Float, y: Float, w: Float, h: Float) = Sec(n, Kind.BAR, x, y, w = w, h = h)

private val VOLLEY = listOf(
    t("team1", 0f, -4f, 18f), box("bg_score1", 0f, 17f, 64f, 46f), t("score1", 32f, 40f, 50f, Align.CENTER, vc = true),
    t("set1", 91f, -5f, 26f, Align.RIGHT), t("vs", 97f, -1f, 18f, Align.CENTER, fixed = "-", col = Led.vsDash), t("set2", 102f, -5f, 26f),
    t("timeout1", 78f, 23f, 18f, Align.CENTER), t("lbl_to", 96f, 26f, 14f, Align.CENTER, fixed = "T", col = Led.label), t("timeout2", 115f, 23f, 18f, Align.CENTER),
    t("sub1", 78f, 39f, 18f, Align.CENTER), t("lbl_sub", 96f, 42f, 14f, Align.CENTER, fixed = "S", col = Led.label), t("sub2", 115f, 39f, 18f, Align.CENTER),
    bar("serve1", 70f, 60f, 16f, 5f), bar("serve2", 107f, 60f, 16f, 5f),
    t("team2", 192f, -4f, 18f, Align.RIGHT), box("bg_score2", 127f, 17f, 64f, 46f), t("score2", 160f, 40f, 50f, Align.CENTER, vc = true),
)
private val BEACH = listOf(
    t("team1", 0f, -4f, 18f), box("bg_score1", 0f, 17f, 64f, 46f), t("score1", 32f, 40f, 50f, Align.CENTER, vc = true),
    t("set1", 89f, -6f, 20f, Align.RIGHT), t("vs", 97f, -3f, 15f, Align.CENTER, fixed = "-", col = Led.vsDash), t("set2", 105f, -6f, 20f),
    t("timeout1", 82f, 15f, 14f, Align.CENTER), t("lbl_to", 98f, 15f, 13f, Align.CENTER, fixed = "T", col = Led.label), t("timeout2", 111f, 15f, 14f, Align.CENTER),
    t("serveplr1", 80f, 23f, 40f, Align.CENTER), t("serveplr2", 111f, 23f, 40f, Align.CENTER),
    t("switch", 96f, 30f, 11f, Align.CENTER),
    t("team2", 192f, -4f, 18f, Align.RIGHT), box("bg_score2", 127f, 17f, 64f, 46f), t("score2", 160f, 40f, 50f, Align.CENTER, vc = true),
)
private val BASKET = listOf(
    t("team1", 0f, -4f, 18f), t("bonus1", 60f, 0f, 15f, Align.CENTER),
    box("bg_score1", 0f, 17f, 64f, 46f), t("score1", 32f, 40f, 50f, Align.CENTER, vc = true),
    t("period", 96f, -6f, 15f, Align.CENTER, col = Color.White),
    t("foul1", 80f, 22f, 15f, Align.CENTER), t("lbl_foul", 96f, 25f, 11f, Align.CENTER, fixed = "F", col = Led.label), t("foul2", 112f, 22f, 15f, Align.CENTER),
    t("timeout1", 80f, 38f, 15f, Align.CENTER), t("lbl_to", 96f, 41f, 11f, Align.CENTER, fixed = "T", col = Led.label), t("timeout2", 112f, 38f, 15f, Align.CENTER),
    bar("serve1", 70f, 60f, 16f, 5f), bar("serve2", 107f, 60f, 16f, 5f),
    t("team2", 192f, -4f, 18f, Align.RIGHT), t("bonus2", 132f, 0f, 15f, Align.CENTER),
    box("bg_score2", 127f, 17f, 64f, 46f), t("score2", 160f, 40f, 50f, Align.CENTER, vc = true),
)
// The simple scoreboard: no boxes, the mapper paints them black on black.
private val SIMPLE = listOf(
    t("team1", 0f, -4f, 18f), t("score1", 32f, 40f, 50f, Align.CENTER, vc = true),
    t("team2", 192f, -4f, 18f, Align.RIGHT), t("score2", 160f, 40f, 50f, Align.CENTER, vc = true),
)

private fun layoutOf(sport: String?) = when (sport) {
    Sport.BEACH -> BEACH
    Sport.BASKETBALL -> BASKET
    Sport.SIMPLE -> SIMPLE
    else -> VOLLEY
}

/** The width the board's mapper sizes a team name into, per sport. */
private fun nameWidth(sport: String?) = when (sport) {
    Sport.BEACH -> 78f
    Sport.BASKETBALL -> 62f
    else -> 86f
}

private const val NAME_GAP = 4f
private const val NAME_MIN = 9f

@Composable
fun BoardMirror(
    sides: Sides?,
    sport: String,
    mode: BoardMode,
    countdown: Countdown?,
    nowMs: Long,
    totalTimeouts: Int,
    totalSubs: Int,
    plainBranding: Boolean,
    /** The name size the board paints for a PANEL side (its ceiling after shrink-to-fit). */
    nameSize: (String, String) -> Float,
    modifier: Modifier = Modifier,
) {
    val c = Ph.colors
    val eink = c.eink
    val measurer = rememberTextMeasurer(cacheSize = 64)
    val crest = ImageBitmap.imageResource(R.drawable.kscw_crest)

    // A changed score blinks on the mirror, as it does on the panel.
    val blink1 = remember { Animatable(1f) }
    val blink2 = remember { Animatable(1f) }
    var seen by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    val p1 = sides?.left?.points ?: 0
    val p2 = sides?.right?.points ?: 0
    LaunchedEffect(p1, p2, sport) {
        val prev = seen
        seen = p1 to p2
        if (prev == null) return@LaunchedEffect
        val spec = keyframes<Float> {
            durationMillis = 1800
            1f at 0; 0.1f at 216; 1f at 450; 0.1f at 666; 1f at 900; 0.1f at 1116; 1f at 1350; 0.1f at 1566; 1f at 1800
        }
        if (prev.first != p1) blink1.animateTo(1f, spec)
        if (prev.second != p2) blink2.animateTo(1f, spec)
    }
    val cdBlinkOn = countdown?.blink == true && mode == BoardMode.COUNTDOWN && (nowMs / 350) % 2 == 1L

    val desc = if (sides == null) "Board preview" else
        "Board preview: ${sides.left.short.ifEmpty { "left" }} ${sides.left.points}, ${sides.right.short.ifEmpty { "right" }} ${sides.right.points}"

    Canvas(
        modifier
            .aspectRatio(BW / BH)
            .clip(RoundedCornerShape(12.dp))
            .border(if (eink) 2.5.dp else Ph.hairline, if (eink) Color.Black else c.line, RoundedCornerShape(12.dp))
            .semantics { contentDescription = desc },
    ) {
        drawRect(if (eink) Color.White else Led.panel)
        val s = size.width / BW
        val ink = { col: Color -> if (eink) Color.Black else col }
        when (mode) {
            BoardMode.IDLE, BoardMode.CLOCK -> drawIdle(measurer, s, sides, mode, nowMs, plainBranding, crest, ink)
            BoardMode.COUNTDOWN -> if (countdown != null) {
                if (!cdBlinkOn) drawCountdown(measurer, s, sides, countdown, nowMs, ink)
            } else drawMatch(measurer, s, sides, sport, totalTimeouts, totalSubs, nameSize, blink1.value, blink2.value, eink, ink)
            BoardMode.MATCH -> drawMatch(measurer, s, sides, sport, totalTimeouts, totalSubs, nameSize, blink1.value, blink2.value, eink, ink)
        }
    }
}

private fun DrawScope.style(px: Float, color: Color, bold: Boolean = false, spacing: TextUnit = (-0.03).em) = TextStyle(
    color = color,
    fontSize = with(this as Density) { px.toSp() },
    fontFamily = FontFamily.SansSerif,
    fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
    letterSpacing = spacing,
    lineHeight = with(this as Density) { px.toSp() },
    lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
)

/** Text at board coordinates, anchored like the CSS (left / centre / right, `vc` = centred on y). */
private fun DrawScope.boardText(
    m: TextMeasurer, s: Float, text: String, x: Float, y: Float, fs: Float, color: Color,
    a: Align, vc: Boolean, maxW: Float? = null, alpha: Float = 1f,
) {
    if (text.isEmpty()) return
    var px = fs * s
    var layout = m.measure(text, style(px, color))
    // A name too wide for its column shrinks (never below the smallest size), then is clipped.
    if (maxW != null && layout.size.width > maxW * s) {
        val next = maxOf(NAME_MIN * s, floor(px * (maxW * s) / layout.size.width * 10) / 10)
        if (next < px) {
            px = next
            layout = m.measure(text, style(px, color))
        }
    }
    val w = layout.size.width.toFloat()
    val h = layout.size.height.toFloat()
    val left = when (a) {
        Align.LEFT -> x * s
        Align.CENTER -> x * s - w / 2
        Align.RIGHT -> x * s - w
    }
    val top = if (vc) y * s - h / 2 else y * s
    if (maxW != null && w > maxW * s) {
        val clipLeft = if (a == Align.RIGHT) x * s - maxW * s else left
        clipRect(clipLeft, top, clipLeft + maxW * s, top + h) { drawText(layout, topLeft = Offset(left, top), alpha = alpha) }
    } else drawText(layout, topLeft = Offset(left, top), alpha = alpha)
}

private fun DrawScope.textWidth(m: TextMeasurer, s: Float, text: String, fs: Float): Float =
    if (text.isEmpty()) 0f else m.measure(text, style(fs * s, Color.White)).size.width / s

private fun teamColor(t: Team) = TeamColors.parse(t.color)?.let { rgb(it) } ?: Color.Gray

private fun DrawScope.drawMatch(
    m: TextMeasurer, s: Float, sd: Sides?, sport: String, totalTimeouts: Int, totalSubs: Int,
    nameSize: (String, String) -> Float, blink1: Float, blink2: Float, eink: Boolean, ink: (Color) -> Color,
) {
    val d = sd ?: Sides(
        Team("", "#4a6cff", 0, 0, 0, 0), Team("", "#ff5b52", 0, 0, 0, 0), null, 0, 1, false,
    )
    val l = d.left
    val r = d.right
    val lc = teamColor(l)
    val rc = teamColor(r)
    val values = HashMap<String, Pair<String, Color>>()
    fun put(n: String, v: Any, col: Color) { values[n] = v.toString() to col }
    put("team1", l.short.uppercase(), lc)
    put("team2", r.short.uppercase(), rc)
    put("score1", l.points, lc)
    put("score2", r.points, rc)
    when (sport) {
        Sport.BASKETBALL -> {
            val toCol = { n: Int -> if (n >= totalTimeouts) Led.red else Led.count }
            val foulCol = { n: Int -> if (n >= Rules.BONUS_AT) Led.foulRed else if (n >= Rules.BONUS_AT - 1) Led.amber else Led.count }
            put("period", if (d.over) "FINAL" else Rules.periodLabel(d.period), Color.White)
            put("foul1", l.sub, foulCol(l.sub)); put("foul2", r.sub, foulCol(r.sub))
            put("bonus1", if (l.sub >= Rules.BONUS_AT) "•" else "", if (l.sub >= Rules.BONUS_AT) Led.foulRed else Led.bonusOff)
            put("bonus2", if (r.sub >= Rules.BONUS_AT) "•" else "", if (r.sub >= Rules.BONUS_AT) Led.foulRed else Led.bonusOff)
            put("timeout1", l.to, toCol(l.to)); put("timeout2", r.to, toCol(r.to))
        }
        Sport.BEACH -> {
            val toCol = { n: Int -> if (n >= totalTimeouts) Led.red else Led.count }
            val due = Rules.switchDue(d)
            put("set1", l.sets, lc); put("set2", r.sets, rc)
            put("switch", if (due) "SWITCH" else "", if (due) Led.amber else Led.switchOff)
            put("timeout1", l.to, toCol(l.to)); put("timeout2", r.to, toCol(r.to))
            // The serving pair's player digit, over that pair's bar; blank while a switch is due.
            val spCol = if (d.serving == "left") lc else if (d.serving == "right") rc else Led.switchOff
            put("serveplr1", if (!due && d.serving == "left" && d.servePlayer > 0) d.servePlayer else "", spCol)
            put("serveplr2", if (!due && d.serving == "right" && d.servePlayer > 0) d.servePlayer else "", spCol)
        }
        Sport.SIMPLE -> Unit
        else -> {
            val toCol = { n: Int -> if (n >= totalTimeouts) Led.red else Led.count }
            val subCol = { n: Int -> if (n >= totalSubs) Led.red else if (n >= totalSubs - 1) Led.amber else Led.count }
            put("set1", l.sets, lc); put("set2", r.sets, rc)
            put("timeout1", l.to, toCol(l.to)); put("timeout2", r.to, toCol(r.to))
            put("sub1", l.sub, subCol(l.sub)); put("sub2", r.sub, subCol(r.sub))
        }
    }
    val layout = layoutOf(sport)
    val colW = nameWidth(sport)
    // Each name stays clear of its set digit by NAME_GAP board px, and inside its column.
    val set1 = layout.firstOrNull { it.n == "set1" }
    val set2 = layout.firstOrNull { it.n == "set2" }
    val set1Text = values["set1"]?.first ?: ""
    val set2Text = values["set2"]?.first ?: ""
    val room1 = if (set1 != null && set1Text.isNotEmpty()) set1.x - textWidth(m, s, set1Text, set1.fs) - NAME_GAP else colW
    val room2 = if (set2 != null && set2Text.isNotEmpty()) BW - (set2.x + textWidth(m, s, set2Text, set2.fs)) - NAME_GAP else colW

    withTransform({ scale(0.85f, 0.85f, pivot = center) }) {
        for (sec in layout) {
            when (sec.kind) {
                Kind.BOX -> {
                    val col = if (sec.n == "bg_score1") lc else rc
                    val bw = 2.2f / 100f * BH * s
                    drawRoundRect(
                        ink(col), Offset(sec.x * s + bw / 2, sec.y * s + bw / 2), Size(sec.w * s - bw, sec.h * s - bw),
                        CornerRadius(0.32f * s), style = Stroke(bw),
                    )
                }
                Kind.BAR -> {
                    val on = (sec.n == "serve1" && d.serving == "left") || (sec.n == "serve2" && d.serving == "right")
                    val col = if (on) (if (sec.n == "serve1") lc else rc) else Led.serveOff
                    if (!eink || on) drawRoundRect(ink(col), Offset(sec.x * s, sec.y * s), Size(sec.w * s, sec.h * s), CornerRadius(0.32f * s))
                }
                Kind.TEXT -> {
                    val (text, col) = if (sec.fixed != null) sec.fixed to (sec.col ?: Color.White)
                    else values[sec.n] ?: continue
                    var fs = sec.fs
                    var maxW: Float? = null
                    if (sec.n == "team1" || sec.n == "team2") {
                        val side = if (sec.n == "team1") "left" else "right"
                        val name = text.ifEmpty { if (side == "left") "TEAM A" else "TEAM B" }
                        fs = nameSize(side, name)
                        maxW = minOf(colW, if (side == "left") room1 else room2)
                    }
                    val alpha = when (sec.n) { "score1" -> blink1; "score2" -> blink2; else -> 1f }
                    boardText(m, s, text, sec.x, sec.y, fs, ink(sec.col ?: col), sec.a, sec.vc, maxW, alpha)
                }
            }
        }
    }
}

/** The names + VS screen (idle) or the clock: the crest, then the names or the time and date. */
private fun DrawScope.drawIdle(
    m: TextMeasurer, s: Float, sd: Sides?, mode: BoardMode, nowMs: Long, plain: Boolean, crest: ImageBitmap, ink: (Color) -> Color,
) {
    val h = size.height
    val w = size.width
    val padX = 0.06f * w
    val gap = 0.05f * w
    val crestH = if (plain) 0f else 0.8f * h
    val crestW = if (plain) 0f else crestH * crest.width / crest.height
    // The right-hand block's content, measured so the pair is centred as the CSS centres it.
    val blocks: List<Pair<androidx.compose.ui.text.TextLayoutResult, Float>>
    if (mode == BoardMode.CLOCK) {
        val cal = Calendar.getInstance().apply { timeInMillis = nowMs }
        fun z(n: Int) = n.toString().padStart(2, '0')
        val time = z(cal.get(Calendar.HOUR_OF_DAY)) + ":" + z(cal.get(Calendar.MINUTE)) + ":" + z(cal.get(Calendar.SECOND))
        val day = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")[cal.get(Calendar.DAY_OF_WEEK) - 1]
        val date = "$day ${z(cal.get(Calendar.DAY_OF_MONTH))}.${z(cal.get(Calendar.MONTH) + 1)}.${cal.get(Calendar.YEAR)}"
        blocks = listOf(
            m.measure(time, style(0.40f * h, ink(Color.White), bold = true, spacing = 0.em)) to 0.04f * h,
            m.measure(date, style(0.18f * h, ink(Led.gold), bold = true, spacing = 0.em)) to 0f,
        )
    } else {
        val n1 = (sd?.left?.short?.ifEmpty { null } ?: "HOME").uppercase()
        val n2 = (sd?.right?.short?.ifEmpty { null } ?: "GUEST").uppercase()
        val c1 = sd?.left?.let { teamColor(it) } ?: Led.idleHome
        val c2 = sd?.right?.let { teamColor(it) } ?: Led.idleGuest
        blocks = listOf(
            m.measure(n1, style(0.23f * h, ink(c1), bold = true, spacing = (-0.02).em)) to 0.031f * h,
            m.measure(n2, style(0.23f * h, ink(c2), bold = true, spacing = (-0.02).em)) to 0f,
        )
    }
    val maxBlockW = (w - 2 * padX - crestW - (if (plain) 0f else gap)).coerceAtLeast(0f)
    val blockW = minOf(maxBlockW, blocks.maxOf { it.first.size.width }.toFloat())
    val totalW = crestW + (if (plain) 0f else gap) + blockW
    var x = (w - totalW) / 2
    if (!plain) {
        drawImage(
            crest, dstOffset = androidx.compose.ui.unit.IntOffset(x.toInt(), ((h - crestH) / 2).toInt()),
            dstSize = androidx.compose.ui.unit.IntSize(crestW.toInt(), crestH.toInt()),
        )
        x += crestW + gap
    }
    val totalH = blocks.sumOf { (it.first.size.height + it.second).toDouble() }.toFloat() +
        if (mode == BoardMode.IDLE) 0.006f * h else 0f
    var y = (h - totalH) / 2
    blocks.forEachIndexed { i, (layout, after) ->
        val lw = layout.size.width.toFloat()
        val left = if (mode == BoardMode.CLOCK) x + (blockW - lw) / 2 else x
        clipRect(x, 0f, x + blockW, h) { drawText(layout, topLeft = Offset(left, y)) }
        y += layout.size.height
        if (mode == BoardMode.IDLE && i == 0) {
            drawRoundRect(ink(Led.sep), Offset(x, y + 0.025f * h), Size(minOf(blockW, blocks.maxOf { it.first.size.width }.toFloat()), 0.006f * h))
            y += 0.006f * h
        }
        y += after
    }
}

/** A break on the board: its label (+ the calling team), the clock, and points or sets beneath. */
private fun DrawScope.drawCountdown(m: TextMeasurer, s: Float, sd: Sides?, cd: Countdown, nowMs: Long, ink: (Color) -> Color) {
    val h = size.height
    val w = size.width
    var label = cd.boardLabel
    if (cd.side != null && sd != null) {
        val t = sd.team(cd.side)
        if (t.short.isNotEmpty()) label += " · " + t.short.uppercase()
    }
    val time = if (cd.endAt > 0) Rules.fmtCountdown((cd.endAt - nowMs) / 1000.0) else cd.score
    val lab = m.measure(label.uppercase(), style(0.12f * h, ink(Led.label), bold = true, spacing = 0.06.em))
    val tim = m.measure(time, style(0.42f * h, ink(Led.cdGold), bold = true, spacing = 0.em).copy(lineHeight = with(this as Density) { (0.42f * h * 0.85f).toSp() }))
    val pick = when (cd.content) { "sets" -> "sets"; "full" -> "points"; else -> null }
    val subParts = if (pick != null && sd != null) {
        val a = if (pick == "sets") sd.left.sets else sd.left.points
        val b = if (pick == "sets") sd.right.sets else sd.right.points
        listOf(
            m.measure(a.toString(), style(0.15f * h, ink(teamColor(sd.left)), bold = true, spacing = 0.em)),
            m.measure("–", style(0.15f * h, ink(Led.cdDash), bold = true, spacing = 0.em)),
            m.measure(b.toString(), style(0.15f * h, ink(teamColor(sd.right)), bold = true, spacing = 0.em)),
        )
    } else emptyList()
    val gap = 0.015f * h
    val subH = subParts.maxOfOrNull { it.size.height }?.toFloat() ?: 0f
    val totalH = lab.size.height + gap + tim.size.height + (if (subParts.isEmpty()) 0f else gap + subH)
    var y = (h - totalH) / 2
    drawText(lab, topLeft = Offset((w - lab.size.width) / 2, y)); y += lab.size.height + gap
    drawText(tim, topLeft = Offset((w - tim.size.width) / 2, y)); y += tim.size.height + gap
    if (subParts.isNotEmpty()) {
        val sg = 0.015f * w
        val totalW = subParts.sumOf { it.size.width } + sg * (subParts.size - 1)
        var x = (w - totalW) / 2
        for (p in subParts) { drawText(p, topLeft = Offset(x, y)); x += p.size.width + sg }
    }
}
