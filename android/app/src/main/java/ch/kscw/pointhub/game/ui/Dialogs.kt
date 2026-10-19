package ch.kscw.pointhub.game.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.kscw.pointhub.game.CurrentMatch
import ch.kscw.pointhub.game.GameController
import ch.kscw.pointhub.game.LogEntry
import ch.kscw.pointhub.game.Rules
import ch.kscw.pointhub.game.ServeOrderUi
import ch.kscw.pointhub.game.Sport
import ch.kscw.pointhub.game.TeamColors

/**
 * Every overlay of the Game tab, in the console's stacking order: the landing pickers and the
 * result at the bottom, the number editor and colours over them, a confirm over those, the PIN pad
 * on top. Hosted by the header so they also work over the console's own tabs (a PIN asked for by a
 * Settings save, the sport picker from the badge).
 */
@Composable
fun GameDialogs(g: GameController) {
    g.sportPicker?.let { SportPickerDialog(g, it) }
    g.gamePicker?.let { GamePickerDialog(g, it) }
    g.matchEnd?.let { MatchEndDialog(g, it) }
    g.liveLog?.let { LiveLogDialog(g, it.match, it.loaded) }
    g.serveOrder?.let { ServeOrderDialog(g, it) }
    g.colorAsk?.let { ColorDialog(g) }
    g.edit?.let { EditDialog(g) }
    g.confirm?.let { ConfirmDialog(g) }
    g.pinPad?.let { PinDialog(g) }
    ToastHost(g.toast, onAction = { g.tapToastAction() }, onClose = { g.clearStickyToast() })
}

@Composable
private fun DialogButtons(content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) =
    Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), content = content)

@Composable
private fun StatusLine(text: String?, bad: Boolean) {
    if (text == null) return
    val c = Ph.colors
    Text(text, color = if (bad) c.bad else c.muted, fontSize = 13.sp, fontWeight = if (bad) FontWeight.Bold else FontWeight.Normal,
        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
}

@Composable
private fun CancelLink(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(top = 18.dp), contentAlignment = Alignment.Center) {
        PhTextButton(text, onClick, enabled = enabled, fontSize = 14)
    }
}

// ------------------------------------------------------------------------------ sport + game menu

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SportPickerDialog(g: GameController, ui: ch.kscw.pointhub.game.SportPickerUi) {
    val c = Ph.colors
    PhDialog(onDismiss = if (ui.busy) null else ({ g.closeSportPicker() })) {
        DialogBox(560.dp, padding = 24.dp) {
            DialogTitle("Choose the sport")
            DialogSub("Switching restarts the board with the new rules and layout — about 8 seconds.")
            val list = g.sports.ifEmpty { Sport.FALLBACK }
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp), maxItemsInEachRow = 4) {
                for (sp in list) {
                    val on = sp.key == g.curSport
                    PhButton(
                        { g.chooseSport(sp.key) }, Modifier.weight(1f).heightIn(min = 96.dp), enabled = !ui.busy,
                        bg = if (on) c.fill else c.card, border = if (on) c.blue else c.line, fg = if (on) c.blue else c.fg,
                        borderWidth = if (on && c.eink) 3.dp else Ph.hairline, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 12.dp),
                    ) { col ->
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(PhIcons.sport(sp.key), null, Modifier.size(30.dp), tint = col)
                            Text(sp.label, color = col, fontSize = 14.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center)
                            if (on) Text("CURRENT", color = c.blue, fontSize = 10.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.6.sp)
                        }
                    }
                }
            }
            StatusLine(ui.status, ui.bad)
            Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally)) {
                PhTextButton("Show clock", { g.sportPickerClock() }, icon = PhIcons.clock, enabled = !ui.busy)
                PhTextButton("Game menu", { g.sportPickerGameMenu() }, icon = PhIcons.list, enabled = !ui.busy)
                PhTextButton("Diagnostics", { g.sportPickerDiag() }, icon = PhIcons.activity)
            }
            CancelLink("Keep current sport", enabled = !ui.busy) { g.closeSportPicker() }
        }
    }
}

@Composable
private fun GameOption(label: String, hint: String, primary: Boolean = false, danger: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Ph.colors
    val col = if (danger) c.bad else if (primary) c.blue else c.fg
    PhButton(
        onClick, Modifier.fillMaxWidth().heightIn(min = 60.dp), enabled = enabled,
        bg = if (primary) c.fill else c.card, border = if (danger) c.bad else if (primary) c.blue else c.line, fg = col,
        borderWidth = if (primary && c.eink) 3.dp else Ph.hairline,
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
    ) { fg ->
        Column(Modifier.fillMaxWidth()) {
            Text(label, color = fg, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold)
            Text(hint, color = if (danger || primary) fg else c.muted, fontSize = 12.sp, style = TextStyle(fontFeatureSettings = "tnum"))
        }
    }
}

@Composable
private fun GamePickerDialog(g: GameController, ui: ch.kscw.pointhub.game.GamePickerUi) {
    val has = ui.saved != null
    PhDialog(onDismiss = { g.closeGamePicker() }) {
        DialogBox(560.dp, padding = 24.dp) {
            DialogTitle(g.sportLabel(g.curSport))
            DialogSub(if (!ui.loaded) "What would you like to do?" else if (has) "There's a match in progress on this board." else "Nothing saved for this sport yet.")
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (has) GameOption("Continue game", Rules.describeSaved(ui.saved!!), primary = true, enabled = !ui.busy) { g.gameContinue() }
                GameOption("New game", "Start from 0–0", primary = !has, enabled = !ui.busy) { g.gameNew() }
                GameOption("Show clock", "Leave the board on the crest and clock", enabled = !ui.busy) { g.gameClock() }
                if (has) GameOption("Delete saved game", "Forget the match in progress", danger = true, enabled = !ui.busy) { g.gameDelete() }
            }
            StatusLine(ui.status, ui.bad)
            // Deliberately never disabled: the one way out when a choice hangs on a silent board.
            CancelLink("Not now") { g.closeGamePicker() }
        }
    }
}

// ------------------------------------------------------------------------------ the result

@Composable
private fun MatchEndDialog(g: GameController, ui: ch.kscw.pointhub.game.MatchEndUi) {
    val c = Ph.colors
    val s = ui.state
    val bball = g.sport == Sport.BASKETBALL
    val nameA = s.teamAShort.ifEmpty { s.teamAName }.ifEmpty { "TEAM A" }.uppercase()
    val nameB = s.teamBShort.ifEmpty { s.teamBName }.ifEmpty { "TEAM B" }.uppercase()
    val (sa, sb) = Rules.tally(g.sport, s)
    fun teamCol(hex: String?): Color? = TeamColors.teamText(hex, colorIntOf(c.card), c.dark)?.let { rgb(it) }
    val colA = if (c.eink) c.fg else teamCol(s.teamAColor)
    val colB = if (c.eink) c.fg else teamCol(s.teamBColor)
    PhDialog(onDismiss = { g.closeMatchEnd() }) {
        DialogBox(560.dp, padding = 24.dp) {
            DialogTitle("Match result")
            if (sa == sb) DialogSub("Match drawn")
            else DialogSub(if (sa > sb) "$nameA wins" else "$nameB wins", color = (if (sa > sb) colA else colB) ?: c.fg)
            Row(Modifier.fillMaxWidth().padding(bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically) {
                Text(nameA, color = colA ?: c.fg, fontSize = 15.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.widthIn(max = 170.dp), textAlign = TextAlign.Center)
                Text(sa.toString(), color = colA ?: c.fg, fontSize = 38.sp, style = MonoStyle)
                Text("–", color = c.muted, fontSize = 24.sp)
                Text(sb.toString(), color = colB ?: c.fg, fontSize = 38.sp, style = MonoStyle)
                Text(nameB, color = colB ?: c.fg, fontSize = 15.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.widthIn(max = 170.dp), textAlign = TextAlign.Center)
            }
            val results = s.setResults
            Row(Modifier.fillMaxWidth().padding(bottom = 18.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                if (results.isEmpty()) Text(if (bball) "No completed periods recorded" else "No completed sets recorded", color = c.muted, fontSize = 13.sp)
                results.forEachIndexed { i, r ->
                    // Basketball's entries are cumulative: the pill shows the points scored IN the period.
                    val prev = if (bball && i > 0) results[i - 1] else null
                    val a = r.a - (prev?.a ?: 0)
                    val b = r.b - (prev?.b ?: 0)
                    Row(
                        Modifier.border(Ph.hairline, c.line, PhShape).padding(horizontal = 10.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(if (bball) Rules.periodLabel(i + 1) else Rules.roman(i + 1), color = c.muted, fontSize = 10.sp, fontWeight = FontWeight.ExtraBold)
                        WinNum(a, a > b, 14)
                        Text("–", color = c.muted, fontSize = 14.sp)
                        WinNum(b, b > a, 14)
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                GameOption("New game", "Start the next match from 0–0", primary = true) { g.matchEndNew() }
                GameOption("Show clock", "Leave the board on the crest and clock") { g.matchEndClock() }
            }
            StatusLine(ui.status, ui.bad)
            CancelLink("Close") { g.closeMatchEnd() }
        }
    }
}

private fun colorIntOf(col: Color): Int =
    ((col.red * 255).toInt() shl 16) or ((col.green * 255).toInt() shl 8) or (col.blue * 255).toInt()

// ------------------------------------------------------------------------------ the match log

@Composable
private fun LiveLogDialog(g: GameController, m: CurrentMatch?, loaded: Boolean) {
    val c = Ph.colors
    PhDialog(onDismiss = { g.closeLiveLog() }) {
        DialogBox(640.dp, padding = 22.dp) {
            DialogTitle("Match log")
            val evs = m?.events ?: emptyList()
            DialogSub(
                if (!loaded) "Loading…"
                else if (m == null || evs.isEmpty()) "Nothing logged yet."
                else "${m.teamA ?: "A"} vs ${m.teamB ?: "B"} · ${evs.size} entries · started ${evs.first().t}",
            )
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("TIME", color = c.muted, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.widthIn(min = 70.dp))
                Text("WHAT", color = c.muted, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.weight(1f))
                if (m != null) Text("${m.teamA ?: "A"} – ${m.teamB ?: "B"}", color = c.muted, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold)
            }
            // Newest first: during a match the question is almost always about the last few minutes.
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 360.dp).padding(top = 6.dp)) {
                itemsIndexed(evs.asReversed()) { i, e -> LogRow(e, m, i % 2 == 0) }
            }
            CancelLink("Close") { g.closeLiveLog() }
        }
    }
}

@Composable
private fun LogRow(e: LogEntry, m: CurrentMatch?, odd: Boolean) {
    val c = Ph.colors
    val col = when (e.type) {
        "set-end", "match-end", "period-end" -> c.gold
        "swap", "switch-due" -> c.blue
        "undo", "set-closed" -> c.muted
        else -> c.fg
    }
    val bold = e.type in setOf("set-end", "match-end", "period-end", "timeout")
    Row(
        Modifier.fillMaxWidth().background(if (odd) c.line.copy(alpha = 0.14f) else Color.Transparent, PhShape).padding(horizontal = 6.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(e.t, color = c.muted, fontSize = 12.5.sp, fontFamily = Ph.mono, modifier = Modifier.widthIn(min = 70.dp))
        Text(Rules.eventText(e, m?.teamA, m?.teamB), color = col, fontSize = 14.sp,
            fontWeight = if (bold) FontWeight.ExtraBold else FontWeight.Normal,
            fontStyle = if (e.type == "undo" || e.type == "set-closed") FontStyle.Italic else FontStyle.Normal,
            modifier = Modifier.weight(1f))
        Text(Rules.logScore(e), color = col, fontSize = 14.sp, style = MonoStyle)
    }
}

// ------------------------------------------------------------------------------ beach serve order

@Composable
private fun ServeOrderDialog(g: GameController, start: ServeOrderUi) {
    var o by remember { mutableStateOf(start) }
    val sides = g.state?.sides()
    // The rows follow the cards: the first is the pair on the scorer's left.
    val l = g.panelSide("left")
    val r = g.panelSide("right")
    fun nameOf(ps: String) = sides?.team(ps)?.short?.ifEmpty { null }?.uppercase() ?: if (ps == "left") "TEAM L" else "TEAM R"
    PhDialog(onDismiss = { g.serveOrder = null }) {
        DialogBox(380.dp) {
            Text("Beach serve order", color = Ph.colors.fg, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold)
            Text("Who serves first, and each pair's first server. The board tracks it automatically after that — override any time.",
                color = Ph.colors.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp, bottom = 14.dp))
            SegGroup("Serves first", listOf(nameOf(l) to (o.first == l), nameOf(r) to (o.first == r))) { i -> o = o.copy(first = if (i == 0) l else r) }
            for (ps in listOf(l, r)) {
                val cur = if (ps == "left") o.left else o.right
                SegGroup("${nameOf(ps)} — first server", listOf("Player 1" to (cur == 1), "Player 2" to (cur == 2))) { i ->
                    o = if (ps == "left") o.copy(left = i + 1) else o.copy(right = i + 1)
                }
            }
            DialogButtons {
                PhTextButton("Cancel", { g.serveOrder = null }, Modifier.weight(1f), fontSize = 15)
                PhTextButton("Set order", { g.confirmServeOrder(o) }, Modifier.weight(1f), fg = Ph.colors.blue, fontSize = 15)
            }
        }
    }
}

@Composable
private fun ColumnScope.SegGroup(q: String, options: List<Pair<String, Boolean>>, onPick: (Int) -> Unit) {
    val c = Ph.colors
    Text(q, color = c.muted, fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 7.dp))
    Row(Modifier.fillMaxWidth().padding(bottom = 13.dp), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        options.forEachIndexed { i, (label, on) ->
            PhButton(
                { onPick(i) }, Modifier.weight(1f), bg = if (on) c.fill else c.card, border = if (on) c.blue else c.line,
                fg = if (on) c.blue else c.fg, borderWidth = if (on && c.eink) 3.dp else Ph.hairline,
                contentPadding = PaddingValues(12.dp),
            ) { col -> Text(label, color = col, fontSize = 15.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1) }
        }
    }
}

// ------------------------------------------------------------------------------ number, colour

/**
 * Tap a number to type it. An empty box is "not typed yet", never zero: the value is applied
 * absolutely, and a cleared field used to wipe a team's score on the panel.
 */
@Composable
private fun EditDialog(g: GameController) {
    val ask = g.edit ?: return
    val c = Ph.colors
    // The current value, selected: typing replaces it (the console's input.select()).
    var field by remember(ask) { mutableStateOf(TextFieldValue(ask.current.toString(), TextRange(0, ask.current.toString().length))) }
    val text = field.text
    var err by remember(ask) { mutableStateOf<String?>(null) }
    val fr = remember { FocusRequester() }
    fun ok() {
        val n = text.trim().toIntOrNull()
        if (n == null) { err = "Enter a number"; return }
        g.edit = null
        ask.onConfirm(maxOf(0, n))
    }
    PhDialog(onDismiss = { g.edit = null }) {
        DialogBox(300.dp) {
            Text(ask.label.uppercase(), color = c.muted, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.3.sp,
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp))
            BasicTextField(
                field, { v -> field = v.copy(text = v.text.filter { it.isDigit() }.take(3)); err = null },
                singleLine = true,
                textStyle = TextStyle(color = c.fg, fontSize = 32.sp, fontFamily = Ph.mono, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center),
                cursorBrush = SolidColor(c.fg),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { ok() }),
                modifier = Modifier.fillMaxWidth().border(Ph.hairline, c.line, PhShape).padding(14.dp).focusRequester(fr),
            )
            if (err != null) Text(err!!, color = c.bad, fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
            DialogButtons {
                PhTextButton("Cancel", { g.edit = null }, Modifier.weight(1f), fontSize = 15)
                PhTextButton("Set", { ok() }, Modifier.weight(1f), fg = c.blue, fontSize = 15)
            }
        }
    }
    LaunchedEffect(ask) { fr.requestFocus() }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ColorDialog(g: GameController) {
    val ask = g.colorAsk ?: return
    val c = Ph.colors
    var hex by remember(ask) { mutableStateOf(ask.current.removePrefix("#").uppercase()) }
    val valid = TeamColors.parse(hex) != null
    fun pick(h: String) { g.colorAsk = null; ask.onPick(h) }
    PhDialog(onDismiss = { g.colorAsk = null }) {
        DialogBox(420.dp) {
            Text(ask.label.uppercase(), color = c.muted, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.3.sp,
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp))
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), maxItemsInEachRow = 7) {
                for (p in TeamColors.PRESETS) {
                    val sel = p.equals("#$hex", ignoreCase = true)
                    Box(
                        Modifier.size(48.dp)
                            .border(if (sel) 3.dp else Ph.hairline, if (sel) c.blue else c.line, PhShape)
                            .padding(4.dp)
                            .background(rgb(TeamColors.parse(p)!!), PhShape)
                            .clickable(onClickLabel = p) { pick(p) },
                    )
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(Ph.tap).border(Ph.hairline, c.line, PhShape).padding(4.dp)
                    .background(if (valid) rgb(TeamColors.parse(hex)!!) else Color.Transparent, PhShape))
                Text("#", color = c.muted, fontSize = 18.sp, fontFamily = Ph.mono)
                BasicTextField(
                    hex, { v -> hex = v.uppercase().filter { it in "0123456789ABCDEF" }.take(6) },
                    singleLine = true,
                    textStyle = TextStyle(color = c.fg, fontSize = 18.sp, fontFamily = Ph.mono, fontWeight = FontWeight.Bold),
                    cursorBrush = SolidColor(c.fg),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (valid) pick("#$hex") }),
                    modifier = Modifier.weight(1f).border(Ph.hairline, c.line, PhShape).padding(10.dp),
                )
            }
            DialogButtons {
                PhTextButton("Cancel", { g.colorAsk = null }, Modifier.weight(1f), fontSize = 15)
                PhTextButton("Use colour", { pick("#$hex") }, Modifier.weight(1f), enabled = valid, fg = c.blue, fontSize = 15)
            }
        }
    }
}

// ------------------------------------------------------------------------------ confirm, PIN

/** The yes is named for what it does, and red when it throws work away. */
@Composable
private fun ConfirmDialog(g: GameController) {
    val ask = g.confirm ?: return
    val c = Ph.colors
    PhDialog(onDismiss = { g.answerConfirm(false) }) {
        DialogBox(380.dp) {
            Text(ask.msg, color = c.fg, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp))
            DialogButtons {
                PhTextButton(ask.no, { g.answerConfirm(false) }, Modifier.weight(1f), fontSize = 15)
                PhTextButton(
                    ask.yes, { g.answerConfirm(true) }, Modifier.weight(1f), fontSize = 15,
                    fg = if (ask.danger) c.onAccent else c.blue, bg = if (ask.danger) c.bad else c.card, border = if (ask.danger) c.bad else c.line,
                )
            }
        }
    }
}

/** The scorer PIN: the lock gate at start (no way round it), or the pad a refused write opens. */
@Composable
private fun PinDialog(g: GameController) {
    val pad = g.pinPad ?: return
    val c = Ph.colors
    var pin by remember(pad.gate) { mutableStateOf("") }
    val fr = remember { FocusRequester() }
    LaunchedEffect(pad.error) { if (pad.error != null) pin = "" }
    PhDialog(onDismiss = if (pad.gate) null else ({ g.cancelPinPad() })) {
        DialogBox(360.dp, padding = if (pad.gate) 28.dp else 18.dp) {
            if (pad.gate) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { Icon(PhIcons.lock, null, Modifier.size(40.dp), tint = c.fg) }
                Text("Scoreboard locked", color = c.fg, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp))
                Text("Enter the scorer PIN to open the controller.", color = c.muted, fontSize = 13.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(bottom = 20.dp))
            } else {
                Text("ENTER SCORER PIN", color = c.muted, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.3.sp,
                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp))
            }
            BasicTextField(
                pin, { v -> pin = v.filter { it.isDigit() }.take(8) },
                singleLine = true,
                textStyle = TextStyle(color = c.fg, fontSize = 28.sp, fontFamily = Ph.mono, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center, letterSpacing = 6.sp),
                cursorBrush = SolidColor(c.fg),
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { g.submitPin(pin) }),
                modifier = Modifier.fillMaxWidth().border(Ph.hairline, c.line, PhShape).padding(12.dp).focusRequester(fr),
            )
            if (pad.error != null) Text(pad.error, color = c.bad, fontSize = 13.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
            DialogButtons {
                if (!pad.gate) PhTextButton("Cancel", { g.cancelPinPad() }, Modifier.weight(1f), fontSize = 15)
                PhTextButton("Unlock", { g.submitPin(pin) }, Modifier.weight(1f), enabled = !pad.busy && pin.isNotEmpty(),
                    fg = if (pad.gate) c.onAccent else c.blue, bg = if (pad.gate) c.blue else c.card, border = if (pad.gate) c.blue else c.line, fontSize = 15)
            }
        }
    }
    LaunchedEffect(pad.gate) { fr.requestFocus() }
}
