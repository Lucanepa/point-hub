package ch.kscw.pointhub.game.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.kscw.pointhub.game.BoardSettings
import ch.kscw.pointhub.game.GameController
import ch.kscw.pointhub.game.Limit
import ch.kscw.pointhub.game.Rules
import ch.kscw.pointhub.game.Sides
import ch.kscw.pointhub.game.Sport
import ch.kscw.pointhub.game.Team
import ch.kscw.pointhub.game.TeamColors

/**
 * The Game tab (web/index.html `#tab-manual`). Two team cards in SCREEN order — where the scorer
 * sits, see Rules.panelSide — with the serve control between them, the board mirror under them
 * (always the panel as the hall sees it), then the set strip, Undo and the match log, then the
 * actions. The countdown card floats over it.
 */
@Composable
fun GameScreen(g: GameController, onUplink: () -> Unit) {
    val c = Ph.colors
    BoxWithConstraints(Modifier.fillMaxSize().background(c.bg)) {
        // Room for the mirror only where there is height for it (a phone on its side has none).
        val roomy = maxHeight >= 470.dp && maxWidth >= 700.dp
        val compact = maxHeight < 440.dp
        Column(
            Modifier.fillMaxSize().padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(if (compact) 6.dp else 10.dp),
        ) {
            UplinkBanner(g, onUplink)
            PrematchBanner(g)
            val dim = when {
                !g.reachable -> 0.45f
                g.locked -> 0.72f
                else -> 1f
            }
            // Controller unreachable: greyed as well as faded, so nobody mistakes them for live.
            val grey = !g.reachable
            Box(Modifier.fillMaxWidth().then(if (roomy) Modifier else Modifier.weight(1f))) {
                Row(
                    Modifier.fillMaxWidth().alpha(dim).grayscale(grey),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TeamCard(g, "left", compact, Modifier.weight(1f))
                    CenterColumn(g)
                    TeamCard(g, "right", compact, Modifier.weight(1f))
                }
            }
            if (roomy) {
                // The mirror takes what the cards leave, sized from that space: an aspect-ratio box
                // with no room at all would fall back to the full width and spill over the cards.
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().alpha(dim).grayscale(grey), contentAlignment = Alignment.Center) {
                    val labelH = 24.dp
                    val h = minOf(maxHeight - labelH, maxWidth / 3)
                    if (h >= 26.dp) Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Row(Modifier.height(18.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("SEEN FROM THE COURT", color = c.muted, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.1.sp)
                            if (g.behind) Text("  (mirrored — you sit behind the board)", color = c.muted, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                        BoardMirror(
                            sides = g.state?.sides(),
                            sport = g.sport,
                            mode = g.boardMode,
                            countdown = g.countdown,
                            nowMs = g.nowMs,
                            totalTimeouts = g.settings.totalTimeouts ?: Rules.defaultTimeouts(g.sport),
                            totalSubs = g.settings.totalSubs,
                            plainBranding = g.settings.branding == "plain",
                            nameSize = { side, _ -> nameFontSize(g, side) },
                            modifier = Modifier.height(h).width(h * 3),
                        )
                    }
                }
            }
            Footer(g, Modifier.alpha(dim).grayscale(grey))
            Actions(g, Modifier.alpha(if (g.reachable) 1f else 0.45f))
        }
        if (!g.reachable) {
            Box(
                Modifier.align(Alignment.Center)
                    .border(2.dp, c.bad, PhShape).background(c.card, PhShape)
                    .padding(horizontal = 18.dp, vertical = 12.dp),
            ) { Text("Not sent — board unreachable", color = c.bad, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold) }
        }
        // A break card sits high where the mirror is shown, so the board's own countdown stays in
        // view under it (the console's `#cd.major{top:32%}`).
        CountdownCard(g, Modifier.align(
            if (g.countdown?.major != true) Alignment.TopCenter
            else if (roomy) androidx.compose.ui.BiasAlignment(0f, -0.36f) else Alignment.Center,
        ))
    }
}

/**
 * The size the PANEL paints a team name at: the board's own number (after its shrink-to-fit),
 * capped by the −/+ ceiling here so a tap moves the mirror before the next status confirms it.
 */
private fun nameFontSize(g: GameController, panelSide: String): Float {
    val ceil = g.settings.fontMax(panelSide) ?: BoardSettings.FONT_DEFAULT
    val board = g.status.boardFontsize(panelSide)
    return (if (board != null) minOf(board, ceil) else ceil).toFloat()
}

// ------------------------------------------------------------------------------ banners

/** The hall Wi-Fi logged the board out: one line with the way to fix it, never a wall. */
@Composable
private fun UplinkBanner(g: GameController, onUplink: () -> Unit) {
    val c = Ph.colors
    if (g.status.uplinkStatus != "portal" || g.uplinkBannerDismissed) return
    Row(
        Modifier.fillMaxWidth()
            .border(2.dp, c.bad, PhShape)
            .background(c.bad.copy(alpha = 0.07f).compositeOver(c.card), PhShape)
            .padding(start = 12.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(PhIcons.wifiOff, null, Modifier.size(20.dp), tint = c.bad)
        Text(
            buildString {
                append("Hall Wi-Fi needs a login ")
                append(if (g.settings.liveScoring == "off") "— the board has no internet" else "— live scoring is paused")
            },
            color = c.fg, fontSize = 15.sp, modifier = Modifier.weight(1f),
        )
        PhTextButton("Log in", onUplink, bg = c.blue, border = c.blue, fg = c.onAccent, fontSize = 15)
        PhButton({ g.uplinkBannerDismissed = true }, label = "Hide this notice") { col ->
            Icon(PhIcons.x, null, Modifier.size(16.dp), tint = c.muted)
        }
    }
}

/**
 * A game started from the schedule is set up while the panel keeps the clock: the teams are only
 * walking in. The two ways on are the warm-up (whose end starts it) or "Start match now".
 */
@Composable
private fun PrematchBanner(g: GameController) {
    val c = Ph.colors
    if (!g.prematchOn) return
    val s = g.state
    fun nm(short: String?, name: String?, d: String) = (short?.ifEmpty { null } ?: name?.ifEmpty { null } ?: d).uppercase()
    val teams = nm(s?.teamAShort, s?.teamAName, "TEAM A") + " vs " + nm(s?.teamBShort, s?.teamBName, "TEAM B")
    val warm = g.warmupRunning
    val sub = if (warm) "— warm-up running; the match starts when it ends"
    else if (g.prematchShowsNames) "— board shows the team names" else "— board shows the clock"
    Row(
        Modifier.fillMaxWidth()
            .border(2.dp, c.gold, PhShape)
            .background(c.gold.copy(alpha = 0.09f).compositeOver(c.card), PhShape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                androidx.compose.ui.text.buildAnnotatedString {
                    append("Ready: ")
                    pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.ExtraBold)); append(teams); pop()
                },
                color = c.fg, fontSize = 17.sp, fontWeight = FontWeight.Bold,
            )
            Text(sub, color = c.gold, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
        if (!warm) PhTextButton("Start warm-up", { g.startWarmup() }, icon = PhIcons.timer, fontSize = 15, minHeight = 52.dp)
        PhTextButton(
            "Start match now", { g.startMatchNow() }, enabled = !g.startingMatch,
            bg = c.blue, border = c.blue, fg = c.onAccent, fontSize = 15, minHeight = 52.dp,
        )
    }
}

// ------------------------------------------------------------------------------ team card

/**
 * The colours a card is painted in: the team's (shaded for contrast), or ink/paper on e-ink. On
 * the team colour, controls are translucent ink over it; on e-ink they are outlines in the ink.
 */
private data class CardInk(val bg: Color, val ink: Color, val border: Color, val eink: Boolean = false) {
    fun surface(alpha: Float): Color = if (eink) Color.Transparent else ink.copy(alpha = alpha)
    fun edge(alpha: Float): Color = if (eink) ink else ink.copy(alpha = alpha)
}

@Composable
private fun cardInk(g: GameController, panel: String, team: Team?): CardInk {
    val c = Ph.colors
    if (c.eink) {
        val inkCard = TeamColors.inkCard(panel, g.state?.sides())
        return if (inkCard) CardInk(Color.Black, Color.White, Color.Black, true) else CardInk(Color.White, Color.Black, Color.Black, true)
    }
    val pan = team?.let { TeamColors.panelFor(it.color) }
    return if (pan != null) CardInk(rgb(pan.bg), rgb(pan.ink), c.line)
    else CardInk(if (panel == "left") c.blue else c.bad, Color.White, c.line)
}

private fun Color.mix(pct: Float): Color = this.copy(alpha = pct)

@Composable
private fun TeamCard(g: GameController, screen: String, compact: Boolean, modifier: Modifier) {
    val c = Ph.colors
    val panel = g.panelSide(screen)
    val sides: Sides? = g.state?.sides()
    val team = sides?.team(panel)
    val ink = cardInk(g, panel, team)
    val ui = g.ui
    val right = screen == "right"
    Column(
        modifier
            .border(if (c.eink && ink.bg == Color.White) 3.dp else Ph.hairline, ink.border, PhShape)
            .background(ink.bg, PhShape)
            .padding(horizontal = 14.dp, vertical = if (compact) 8.dp else 12.dp),
        verticalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 14.dp),
    ) {
        // Name · size · colour (mirrored on the right card).
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (right) { ColorSwatch(g, screen, team, ink); FontBox(g, screen, ink) }
            NameField(g, screen, team, ink, right, Modifier.weight(1f))
            if (!right) { FontBox(g, screen, ink); ColorSwatch(g, screen, team, ink) }
        }
        ScoreCluster(g, screen, team, ink, compact)
        if (!compact && !g.prematchOn) {
            Text("Tap to set the score manually", color = ink.ink, fontSize = 12.sp, lineHeight = 14.sp, fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().offset(y = (-4).dp))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (ui.showTo) StatTile(g, screen, "timeout", ui.toLabel, team?.to ?: 0,
                Rules.timeoutLimit(g.sport, g.settings, team?.to ?: 0), ink, Modifier.weight(1f))
            if (ui.showSet) StatTile(g, screen, "set", ui.setLabel, team?.sets ?: 0, Limit.NONE, ink, Modifier.weight(1f))
            if (ui.showSub) StatTile(g, screen, "sub", ui.subLabel, team?.sub ?: 0,
                Rules.subLimit(g.sport, g.settings, team?.sub ?: 0), ink, Modifier.weight(1f))
        }
    }
}

/**
 * The team's short name, typed straight into the board's name box: upper case, at most 12, sent
 * when the keyboard's Done is pressed or the field loses focus. Never overwritten while being typed.
 */
@Composable
private fun NameField(g: GameController, screen: String, team: Team?, ink: CardInk, right: Boolean, modifier: Modifier) {
    val panel = g.panelSide(screen)
    val remote = team?.short ?: ""
    var text by remember(panel) { mutableStateOf(remote) }
    var focused by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    LaunchedEffect(remote, focused) { if (!focused) text = remote }
    val flash = remember { Animatable(0f) }
    val nf = g.nameFlash[panel] ?: 0
    LaunchedEffect(nf) {
        if (nf == 0) return@LaunchedEffect
        repeat(3) { flash.animateTo(1f, keyframes { durationMillis = 1000; 0f at 0; 1f at 500; 0f at 1000 }); flash.snapTo(0f) }
    }
    val c = Ph.colors
    val textCol = lerp(ink.ink, c.ok, flash.value)
    // Done and the focus leaving both send; the second must not send the same name again (it would
    // land on the busy gate and read "that one didn't go through").
    var sent by remember(panel) { mutableStateOf<String?>(null) }
    LaunchedEffect(remote) { sent = null }
    fun send() {
        val v = text.uppercase().take(12)
        text = v
        if (v == remote || v == sent) return
        sent = v
        g.teamName(screen, v)
    }
    Box(
        modifier
            .heightIn(min = Ph.tap)
            .border(Ph.hairline, ink.edge(0.42f), PhShape)
            .background(ink.surface(0.16f), PhShape)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        contentAlignment = if (right) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        if (text.isEmpty()) {
            Text(g.ui.placeholder(panel), color = ink.ink.mix(0.6f), fontSize = 16.sp, fontWeight = FontWeight.ExtraBold,
                letterSpacing = 0.5.sp, modifier = Modifier.fillMaxWidth(), textAlign = if (right) TextAlign.End else TextAlign.Start)
        }
        BasicTextField(
            value = text,
            onValueChange = { v -> text = v.uppercase().filter { it != '\n' }.take(12) },
            singleLine = true,
            textStyle = TextStyle(color = textCol, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.5.sp,
                textAlign = if (right) TextAlign.End else TextAlign.Start),
            cursorBrush = SolidColor(ink.ink),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done, autoCorrectEnabled = false),
            keyboardActions = KeyboardActions(onDone = { send(); focus.clearFocus() }),
            modifier = Modifier.fillMaxWidth()
                .semantics { contentDescription = (if (right) "Right" else "Left") + " team name" }
                .onFocusChanged { st ->
                    if (focused && !st.isFocused) send()
                    focused = st.isFocused
                },
        )
    }
}

private fun lerp(a: Color, b: Color, t: Float): Color =
    if (t <= 0f) a else androidx.compose.ui.graphics.lerp(a, b, t)

/** The size of this team's name on the LED panel: the ceiling a long name still shrinks under. */
@Composable
private fun FontBox(g: GameController, screen: String, ink: CardInk) {
    val panel = g.panelSide(screen)
    val n = g.settings.fontMax(panel)
    val bump = remember { Animatable(1f) }
    LaunchedEffect(g.fontBump) { if (g.fontBump > 0) bump.animateTo(1f, keyframes { durationMillis = 500; 1f at 0; 1.5f at 200; 1f at 500 }) }
    Row(
        Modifier.border(Ph.hairline, ink.edge(0.34f), PhShape).background(ink.surface(0.12f), PhShape),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val down = n == null || n > BoardSettings.FONT_MIN
        val up = n == null || n < BoardSettings.FONT_MAX
        SmallGlyph("−", ink.ink, down, "Smaller name for this team on the panel") { g.nudgeFont(screen, -1) }
        Text(n?.toString() ?: "–", color = ink.ink.mix(0.75f), fontSize = 13.sp, style = MonoStyle,
            modifier = Modifier.width(22.dp).scale(bump.value), textAlign = TextAlign.Center)
        SmallGlyph("+", ink.ink, up, "Bigger name for this team on the panel") { g.nudgeFont(screen, 1) }
    }
}

@Composable
private fun SmallGlyph(glyph: String, color: Color, enabled: Boolean, label: String, onClick: () -> Unit) {
    Box(
        Modifier.size(Ph.tap).clickable(enabled = enabled, onClickLabel = label, onClick = onClick).alpha(if (enabled) 1f else 0.3f)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { Text(glyph, color = color, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold) }
}

@Composable
private fun ColorSwatch(g: GameController, screen: String, team: Team?, ink: CardInk) {
    val col = team?.let { TeamColors.parse(it.color) }?.let { rgb(it) } ?: Color.Gray
    Box(
        Modifier.size(Ph.tap)
            .border(Ph.hairline, ink.edge(0.5f), PhShape)
            .padding(5.dp)
            .background(col, PhShape)
            .border(2.dp, Color.White.copy(alpha = 0.85f), PhShape)
            .clickable(onClickLabel = "Change this team's colour") { g.pickColor(screen) }
            .semantics { contentDescription = (if (screen == "left") "Left" else "Right") + " team colour" },
    )
}

/** − score + (or basketball's score, +1 +2 +3 and a −1 correction). Tap the number to type it. */
@Composable
private fun ScoreCluster(g: GameController, screen: String, team: Team?, ink: CardInk, compact: Boolean) {
    val c = Ph.colors
    val panel = g.panelSide(screen)
    val points = team?.points ?: 0
    // The point just assigned pulses green: the tap registered (also for a point from another tablet).
    val pulse = remember(panel, g.sport) { Animatable(0f) }
    var seen by remember(panel, g.sport) { mutableStateOf<Int?>(null) }
    val flashN = g.pointFlash[panel] ?: 0
    LaunchedEffect(points, flashN) {
        val prev = seen
        seen = points
        if (prev == null && flashN == 0) return@LaunchedEffect
        if (prev != null && prev == points && flashN == 0) return@LaunchedEffect
        pulse.snapTo(0f)
        pulse.animateTo(0f, keyframes { durationMillis = 800; 0f at 0; 1f at 200; 0f at 800 })
    }
    val valueText: @Composable (Modifier) -> Unit = { m ->
        // Tighter while the pre-match banner is up, so the mirror keeps room to show the board's clock.
        val tight = compact || g.prematchOn
        val size = if (g.sport == Sport.BASKETBALL) (if (tight) 44 else 64) else (if (tight) 56 else 84)
        Text(
            points.toString(),
            color = lerp(ink.ink, c.ok, pulse.value),
            // line-height .9, as the console: the numeral's own box, no font padding around it.
            style = TightNumber.copy(fontSize = size.sp),
            textAlign = TextAlign.Center, maxLines = 1, softWrap = false,
            modifier = m
                .clickable(onClickLabel = "Set the score manually") { g.editValue(screen, "points", "score") }
                // A box of line-height .9, as the console's: the glyph is centred in it and may
                // overflow it, instead of the font's own ascent and descent setting the card height.
                .height((size * 0.9f).dp)
                .wrapContentHeight(Alignment.CenterVertically, unbounded = true)
                .scale(1f + 0.3f * pulse.value),
        )
    }
    val big: Dp = if (compact || g.prematchOn) 52.dp else 74.dp
    if (g.sport == Sport.BASKETBALL) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            valueText(Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (d in 1..3) ScoreButton(g, screen, d, "+$d", ink, Modifier.weight(1f).height(if (compact) Ph.tap else 54.dp), 20)
            }
            ScoreButton(g, screen, -1, "−1", ink, Modifier.fillMaxWidth().height(Ph.tap), 20, faint = true)
        }
    } else {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ScoreButton(g, screen, -1, "−", ink, Modifier.size(big), 34)
            valueText(Modifier.weight(1f))
            ScoreButton(g, screen, 1, "+", ink, Modifier.size(big), 34)
        }
    }
}

@Composable
private fun ScoreButton(g: GameController, screen: String, delta: Int, glyph: String, ink: CardInk, modifier: Modifier, fontSize: Int, faint: Boolean = false) {
    val key = "pt:$screen:$delta"
    val side = if (screen == "left") "Left" else "Right"
    PhButton(
        { g.point(screen, delta) }, modifier,
        enabled = g.busyKey != key,
        bg = ink.surface(if (faint) 0.12f else 0.16f), border = ink.edge(0.34f), fg = ink.ink, pressedBg = ink.ink.mix(0.30f),
        contentPadding = PaddingValues(0.dp), notSent = g.notSent[key] == true,
        label = if (delta > 0) "$side plus $delta" else "$side minus ${-delta}",
    ) { col -> Text(glyph, color = col, fontSize = fontSize.sp, fontWeight = FontWeight.Bold) }
}

/** A stat tile: label, number, −/+ underneath. A tap anywhere else on the tile types the number. */
@Composable
private fun StatTile(g: GameController, screen: String, stat: String, label: String, value: Int, limit: Limit, ink: CardInk, modifier: Modifier) {
    val c = Ph.colors
    val field = when (stat) { "timeout" -> "to"; "set" -> "sets"; else -> "sub" }
    val name = when (stat) { "timeout" -> "timeouts"; "set" -> "sets"; else -> if (g.sport == Sport.BASKETBALL) "fouls" else "subs" }
    val bump = remember(g.panelSide(screen), stat, g.sport) { Animatable(1f) }
    var seen by remember(g.panelSide(screen), stat, g.sport) { mutableStateOf<Int?>(null) }
    LaunchedEffect(value) {
        val prev = seen
        seen = value
        if (prev != null && prev != value) bump.animateTo(1f, keyframes { durationMillis = 500; 1f at 0; 1.5f at 200; 1f at 500 })
    }
    // The console's pale amber reads on a dark card only; on a light team colour (yellow, white)
    // the warning is a dark amber instead, or it vanishes into the card.
    val darkInk = ink.ink.red + ink.ink.green + ink.ink.blue < 1.5f
    val warnCol = if (c.eink) ink.ink else if (darkInk) Color(0xFF7A4100) else Color(0xFFFFE08A)
    val textCol = when (limit) { Limit.WARN -> warnCol; else -> ink.ink }
    val maxed = limit == Limit.MAXED
    val tileBg = if (c.eink && maxed) ink.ink else ink.surface(if (maxed) 0.30f else 0.15f)
    val tileText = if (c.eink && maxed) ink.bg else textCol
    Column(
        modifier
            .then(
                if (c.eink && limit == Limit.WARN) Modifier.dashedBorder(ink.ink)
                else Modifier.border(Ph.hairline, if (maxed) ink.ink else ink.edge(0.26f), PhShape),
            )
            .background(tileBg, PhShape)
            .clickable(onClickLabel = "Set $name manually") { g.editValue(screen, field, name) }
            .padding(top = 7.dp, bottom = 8.dp, start = 4.dp, end = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(label.uppercase(), color = tileText, fontSize = 12.sp, lineHeight = 14.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.sp, maxLines = 1)
        Text(value.toString(), color = tileText, style = TightNumber.copy(fontSize = 22.sp, lineHeight = 22.sp), modifier = Modifier.scale(bump.value))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 2.dp)) {
            for (d in listOf(-1, 1)) {
                val key = "stat:$screen:$stat:$d"
                PhButton(
                    { g.stat(screen, stat, d) },
                    Modifier.size(Ph.tap),
                    enabled = g.busyKey != key,
                    bg = if (c.eink) Color.Transparent else ink.ink.mix(0.16f),
                    border = if (c.eink && maxed) ink.bg else ink.edge(0.34f),
                    fg = tileText, pressedBg = ink.ink.mix(0.30f),
                    contentPadding = PaddingValues(0.dp), notSent = g.notSent[key] == true,
                    label = (if (screen == "left") "left " else "right ") + "$name " + (if (d > 0) "plus" else "minus"),
                ) { col -> Text(if (d > 0) "+" else "−", color = col, fontSize = 20.sp, fontWeight = FontWeight.Bold) }
            }
        }
    }
}

private fun Modifier.grayscale(on: Boolean): Modifier = if (!on) this else this.drawWithCache {
    val paint = androidx.compose.ui.graphics.Paint().apply {
        colorFilter = androidx.compose.ui.graphics.ColorFilter.colorMatrix(androidx.compose.ui.graphics.ColorMatrix().apply { setToSaturation(0f) })
    }
    onDrawWithContent {
        drawIntoCanvas { canvas ->
            canvas.saveLayer(androidx.compose.ui.geometry.Rect(0f, 0f, size.width, size.height), paint)
            drawContent()
            canvas.restore()
        }
    }
}

private fun Modifier.dashedBorder(color: Color) = this.drawBehind {
    drawRoundRect(
        color, style = androidx.compose.ui.graphics.drawscope.Stroke(
            width = 2.dp.toPx(), pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(8f, 6f)),
        ),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(Ph.radius.toPx()),
    )
}

// ------------------------------------------------------------------------------ centre column

@Composable
private fun CenterColumn(g: GameController) {
    val c = Ph.colors
    val ui = g.ui
    val beach = g.sport == Sport.BEACH
    val bball = g.sport == Sport.BASKETBALL
    if (!ui.showServe && !beach && !bball) return
    Column(
        Modifier.border(Ph.hairline, c.line, PhShape).background(c.card, PhShape).padding(horizontal = 10.dp, vertical = 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (ui.showServe) ServeToggle(g)
        if (beach) {
            val sides = g.state?.sides()
            val n = sides?.servePlayer ?: 0
            val servingTeam = sides?.serving?.let { sides.team(it) }
            val numCol = servingTeam?.let { t -> TeamColors.teamText(t.color, colorInt(c.card), c.dark)?.let { rgb(it) } } ?: c.fg
            PhButton(
                { g.servePlayer() }, Modifier.width(64.dp), enabled = g.busyKey != "plr",
                contentPadding = PaddingValues(vertical = 7.dp), notSent = g.notSent["plr"] == true,
                label = "Switch the serving player",
            ) { _ ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("PLAYER", color = c.muted, fontSize = 9.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.sp)
                    Text(if (n > 0) n.toString() else "–", color = if (c.eink) c.fg else numCol, fontSize = 24.sp, style = MonoStyle)
                }
            }
            PhTextButton("Serve order", { g.openServeOrder() }, fg = c.blue, fontSize = 11)
        }
        if (bball) {
            val s = g.state?.sides()
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("PERIOD", color = c.muted, fontSize = 10.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.sp)
                Row(
                    Modifier.border(Ph.hairline, c.line, PhShape).padding(4.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    PhButton({ g.period(-1) }, Modifier.size(Ph.tap), border = Color.Transparent, contentPadding = PaddingValues(0.dp),
                        enabled = g.busyKey != "period:-1", label = "Previous period") { col -> Text("−", color = col, fontSize = 20.sp, fontWeight = FontWeight.Bold) }
                    Text(if (s == null) "Q1" else if (s.over) "FINAL" else Rules.periodLabel(s.period), color = c.fg, fontSize = 20.sp, style = MonoStyle,
                        modifier = Modifier.widthIn(min = 44.dp), textAlign = TextAlign.Center)
                    PhButton({ g.period(1) }, Modifier.size(Ph.tap), border = Color.Transparent, contentPadding = PaddingValues(0.dp),
                        enabled = g.busyKey != "period:1", label = "Next period") { col -> Text("+", color = col, fontSize = 20.sp, fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}

private fun colorInt(col: Color): Int =
    ((col.red * 255).toInt() shl 16) or ((col.green * 255).toInt() shl 8) or (col.blue * 255).toInt()

/** ‹ SERVE ›: the arrow of the serving side is filled with that team's (shaded) colour. */
@Composable
private fun ServeToggle(g: GameController) {
    val c = Ph.colors
    val sides = g.state?.sides()
    Row(
        Modifier.border(Ph.hairline, c.line, PhShape).background(c.card, PhShape).padding(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (screen in listOf("left", "right")) {
            if (screen == "right") Text(g.ui.serveLabel, color = c.muted, fontSize = 10.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.sp,
                modifier = Modifier.padding(horizontal = 3.dp))
            val panel = g.panelSide(screen)
            val on = sides?.serving == panel
            val team = sides?.team(panel)
            val pan = team?.let { TeamColors.panelFor(it.color) }
            val fill = if (c.eink) Color.Black else pan?.let { rgb(it.bg) } ?: (if (screen == "left") c.blue else c.bad)
            val arrowInk = if (c.eink) Color.White else pan?.let { rgb(it.ink) } ?: Color.White
            val key = "serve:$screen"
            PhButton(
                { g.serve(screen) }, Modifier.size(Ph.tap),
                enabled = g.busyKey != key,
                bg = if (on) fill else Color.Transparent,
                border = if (on && c.dark) c.fg else Color.Transparent,
                fg = if (on) arrowInk else c.muted,
                contentPadding = PaddingValues(0.dp), notSent = g.notSent[key] == true,
                label = "Serve $screen",
            ) { col -> Icon(if (screen == "left") PhIcons.chevronLeft else PhIcons.chevronRight, null, Modifier.size(20.dp), tint = col) }
        }
    }
}

// ------------------------------------------------------------------------------ footer

@Composable
private fun Footer(g: GameController, modifier: Modifier) {
    val c = Ph.colors
    val s = g.state
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val results = s?.setResults ?: emptyList()
        if (results.isNotEmpty()) {
            // In the order the CARDS are in: the first number is the team on the scorer's left.
            val aFirst = s!!.aIsLeft == (g.panelSide("left") == "left")
            // Shrinks (and scrolls) only when it must: Undo and the log keep their room (`flex:0 1 auto`).
            Row(
                Modifier.widthIn(max = 460.dp).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                results.forEachIndexed { i, r ->
                    val l = if (aFirst) r.a else r.b
                    val rt = if (aFirst) r.b else r.a
                    SetPill(Rules.roman(i + 1), l, rt)
                }
                PhButton({ g.removeLastSet() }, label = "Remove last set") { col ->
                    Icon(PhIcons.delete, null, Modifier.size(17.dp), tint = c.muted)
                }
            }
        }
        val can = g.status.canUndo
        val label = if (can) g.status.undoLabel else ""
        PhButton(
            { g.undo() }, Modifier.widthIn(max = 230.dp),
            enabled = can && g.busyKey != "undo", fg = c.blue, contentPadding = PaddingValues(horizontal = 12.dp),
            notSent = g.notSent["undo"] == true,
            label = if (can) "Undo: " + label.ifEmpty { "the last action" } else "Nothing to undo",
        ) { col ->
            Icon(PhIcons.undo, null, Modifier.size(17.dp), tint = if (can) col else c.muted)
            Text("Undo", color = if (can) col else c.muted, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
            if (label.isNotEmpty()) Text(label, color = c.muted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        val log = g.status.log
        if (log != null) {
            PhButton(
                { g.openLiveLog() }, Modifier.weight(1f), bg = c.card, contentPadding = PaddingValues(horizontal = 12.dp),
                label = "Match log, ${log.n} entries. Last: ${log.last.t} ${Rules.eventText(log.last, log.teamA, log.teamB)} ${Rules.logScore(log.last)}",
                arrangement = Arrangement.spacedBy(8.dp), contentAlignment = Alignment.CenterStart,
            ) { col ->
                Icon(PhIcons.list, null, Modifier.size(17.dp), tint = col)
                Text(log.last.t, color = c.muted, fontSize = 12.sp, fontFamily = Ph.mono, maxLines = 1)
                Text(Rules.eventText(log.last, log.teamA, log.teamB), color = col, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text(Rules.logScore(log.last), color = col, fontSize = 14.sp, style = MonoStyle, maxLines = 1)
            }
        } else Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun SetPill(n: String, l: Int, r: Int) {
    val c = Ph.colors
    Row(
        Modifier.border(Ph.hairline, c.line, androidx.compose.foundation.shape.RoundedCornerShape(4.dp))
            .background(c.card, androidx.compose.foundation.shape.RoundedCornerShape(4.dp))
            .padding(horizontal = 11.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(n, color = c.muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(end = 3.dp))
        WinNum(l, l > r)
        Text("–", color = c.muted, fontSize = 12.sp, fontFamily = Ph.mono)
        WinNum(r, r > l)
    }
}

@Composable
fun WinNum(n: Int, win: Boolean, size: Int = 12) {
    val c = Ph.colors
    Text(
        n.toString(), color = if (win) c.fg else c.muted, fontSize = size.sp, fontFamily = Ph.mono,
        fontWeight = if (win) FontWeight.ExtraBold else FontWeight.SemiBold,
        textDecoration = if (win && c.eink) TextDecoration.Underline else null,
    )
}

@Composable
private fun Actions(g: GameController, modifier: Modifier) {
    val c = Ph.colors
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        PhTextButton("VS", { g.idle() }, icon = PhIcons.volleyball)
        PhTextButton("Show clock", { g.clockButton() }, icon = PhIcons.clock)
        PhTextButton("Warm-up", { g.startWarmup() }, icon = PhIcons.timer)
        if (g.sport == Sport.BASKETBALL) PhTextButton("End period", { g.endPeriod() }, icon = PhIcons.flag)
        PhTextButton("Switch sides", { g.swap() }, icon = PhIcons.arrowLeftRight, fg = c.blue,
            enabled = g.busyKey != "swap", notSent = g.notSent["swap"] == true)
        Spacer(Modifier.weight(1f))
        Box(Modifier.width(Ph.hairline).height(32.dp).background(c.lineSoft))
        Spacer(Modifier.width(2.dp))
        PhTextButton("Reset match", { g.reset() }, fg = c.bad)
    }
}

// ------------------------------------------------------------------------------ countdown card

@Composable
private fun CountdownCard(g: GameController, modifier: Modifier) {
    val c = Ph.colors
    val cd = g.countdown ?: return
    val blinkOff = cd.blink && (g.nowMs / 350) % 2 == 1L
    val time = if (cd.endAt > 0) Rules.fmtCountdown((cd.endAt - g.nowMs) / 1000.0) else cd.score
    val box = Modifier
        .padding(top = if (cd.major) 0.dp else 10.dp)
        .border(Ph.hairline, c.line, PhShape)
        .background(c.card, PhShape)
        .clickable(remember { MutableInteractionSource() }, null) {}
    if (cd.major) {
        Column(
            modifier.then(box).padding(horizontal = 42.dp, vertical = 26.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(time, color = c.warn, fontSize = 66.sp, style = MonoStyle, modifier = Modifier.alpha(if (blinkOff) 0.15f else 1f))
            Text(cd.label.uppercase(), color = if (cd.blink) c.blue else c.fg, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.5.sp,
                modifier = Modifier.alpha(if (blinkOff) 0.15f else 1f))
            PhTextButton(cd.action ?: "✕", { g.tapCountdownButton() }, fg = c.blue, fontSize = 16)
        }
    } else {
        Row(
            modifier.then(box).padding(horizontal = 18.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(time, color = c.warn, fontSize = 30.sp, style = MonoStyle)
            Text(cd.label.uppercase(), color = c.fg, fontSize = 14.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.5.sp)
            PhButton({ g.tapCountdownButton() }, label = cd.action ?: "Skip") { col ->
                if (cd.action != null) Text(cd.action, color = col, fontSize = 15.sp, fontWeight = FontWeight.ExtraBold)
                else Icon(PhIcons.x, null, Modifier.size(16.dp), tint = col)
            }
        }
    }
}
