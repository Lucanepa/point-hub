package ch.kscw.pointhub.game

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/** What the LED panel is showing, so the mirror can follow it (`board.mode` in the console). */
enum class BoardMode { MATCH, IDLE, CLOCK, COUNTDOWN }

enum class CdKind { TIMEOUT, INTERVAL, WARMUP, TTO, SET_ENDED }

/**
 * A countdown card. [label] is what the tablet shows ("TO KSCW"); [boardLabel] is what the board was
 * sent ("TIME OUT"), which is also how the console recognises which clock is running.
 */
data class Countdown(
    val kind: CdKind,
    val label: String,
    val boardLabel: String,
    /** 0 for the "SET ENDED" card, which has no clock. */
    val endAt: Long,
    val major: Boolean,
    /** The button's words; null = a plain ✕ (skip). */
    val action: String?,
    /** What the board shows beside the clock: full | sets | none. */
    val content: String,
    /** PANEL side of the team that called it (timeouts), for the mirror's label. */
    val side: String?,
    val blink: Boolean,
    /** The SET ENDED card shows the final score instead of a clock. */
    val score: String = "",
)

data class ToastMsg(
    val id: Long,
    val msg: String,
    val actionLabel: String? = null,
    val action: (() -> Unit)? = null,
    val sticky: Boolean = false,
    val bad: Boolean = false,
    val ms: Long = 3_200,
)

data class ConfirmAsk(val msg: String, val yes: String, val no: String, val danger: Boolean, val answer: CompletableDeferred<Boolean>)
data class EditAsk(val label: String, val current: Int, val onConfirm: (Int) -> Unit)
data class ColorAsk(val label: String, val current: String, val onPick: (String) -> Unit)
data class SportPickerUi(val busy: Boolean = false, val status: String? = null, val bad: Boolean = false)
data class GamePickerUi(
    val saved: SavedGame? = null,
    val loaded: Boolean = false,
    val busy: Boolean = false,
    val status: String? = null,
    val bad: Boolean = false,
)
data class MatchEndUi(val state: LiveState, val status: String? = null, val bad: Boolean = false)
data class LiveLogUi(val match: CurrentMatch? = null, val loaded: Boolean = false)
/** Beach serve order: who serves first (PANEL side) and each pair's first server, per PANEL side. */
data class ServeOrderUi(val first: String, val left: Int, val right: Int)
data class PinPadUi(val gate: Boolean, val error: String? = null, val busy: Boolean = false)

/**
 * What the Game tab needs from the app around it: where the board is, how to reach it, and two
 * values kept across restarts. The tablet app and the desktop app each provide one.
 */
interface GameHost {
    /** The scorer PIN this device holds for the board ("" = none). */
    var scorerPin: String
    /** The finished match the "show the result?" prompt was last asked about. */
    var endAskedSig: String?
    /** The board's origin when no console page has told us one yet (discovery's answer), or null. */
    fun boardOrigin(): String?
    /** An HTTP(S) connection to [url], over the board's own network where the platform has one. */
    fun open(url: java.net.URL): java.net.HttpURLConnection
}

/**
 * The native Game tab: everything web/index.html does for its Game tab, against the same board API.
 *
 * Ported function by function, with the console's names, so a change on one side can be found on
 * the other. All state is Compose snapshot state and every method runs on the main thread; the
 * network calls suspend off it (BoardApi). One instance per process, so a countdown or a half-sent
 * action survives the activity being recreated, exactly as a long-lived console page would.
 */
class GameController(private val host: GameHost) {
    companion object {
        const val POLL_MS = 1_500L
    }

    private val scope = MainScope()

    /** The origin the console page is on; the native screen talks to the same board. */
    @Volatile var origin: String? = null

    val api = BoardApi(
        origin = { origin ?: host.boardOrigin() },
        open = { url -> host.open(url) },
        pin = { scorerPin },
    )

    // ------------------------------------------------------------------------------ state

    var status by mutableStateOf(BoardStatus()); private set
    var settings by mutableStateOf(BoardSettings()); private set
    var sport by mutableStateOf(""); private set
    var sports by mutableStateOf<List<SportOption>>(emptyList()); private set

    /** The controller (the board's API) answered the last poll or write. */
    var reachable by mutableStateOf(true); private set
    var lastGoodAt by mutableLongStateOf(0L); private set
    /** ✕ on the "board not connected" banner, for this outage only. */
    var offlineDismissed by mutableStateOf(false)
    var uplinkBannerDismissed by mutableStateOf(false)

    var boardMode by mutableStateOf(BoardMode.MATCH); private set
    var countdown by mutableStateOf<Countdown?>(null); private set
    /** Ticks every 250 ms: the countdown card and the mirror's clock read it. */
    var nowMs by mutableLongStateOf(System.currentTimeMillis()); private set
    var prematchOn by mutableStateOf(false); private set

    var scorerPin by mutableStateOf(host.scorerPin); private set
    var pinRequired by mutableStateOf(false); private set

    // Dialogs. Several can be open at once (a PIN pad over the sport picker, a confirm over the game
    // menu), so each has its own slot; the UI stacks them in a fixed order.
    var sportPicker by mutableStateOf<SportPickerUi?>(null); private set
    var gamePicker by mutableStateOf<GamePickerUi?>(null); private set
    var matchEnd by mutableStateOf<MatchEndUi?>(null); private set
    var liveLog by mutableStateOf<LiveLogUi?>(null); private set
    var serveOrder by mutableStateOf<ServeOrderUi?>(null)
    var edit by mutableStateOf<EditAsk?>(null)
    var colorAsk by mutableStateOf<ColorAsk?>(null)
    var confirm by mutableStateOf<ConfirmAsk?>(null); private set
    var pinPad by mutableStateOf<PinPadUi?>(null); private set
    var toast by mutableStateOf<ToastMsg?>(null); private set

    /** The control whose write is in flight (disabled) and the ones whose write failed (ringed red). */
    var busyKey by mutableStateOf<String?>(null); private set
    val notSent = mutableStateMapOf<String, Boolean>()
    /** Bumped to replay a flash on a PANEL side's points / name (set won, match won). */
    val pointFlash = mutableStateMapOf("left" to 0, "right" to 0)
    val nameFlash = mutableStateMapOf("left" to 0, "right" to 0)
    /** Bumped when a font size moved, so the card's number pulses. */
    var fontBump by mutableIntStateOf(0); private set

    /** Asks the shell to switch tabs ("game", "settings" + anchor "uplink", "diag"). */
    var onShowTab: ((tab: String, anchor: String?) -> Unit)? = null

    // ------------------------------------------------------------------------------ lifecycle

    private var pollJob: Job? = null
    private var tickJob: Job? = null
    private var started = false

    /** The native screen is up: poll, and on the first start do what the console does at boot. */
    fun start() {
        if (pollJob?.isActive != true) {
            pollJob = scope.launch {
                while (isActive) {
                    refreshStatus()
                    delay(POLL_MS)
                }
            }
        }
        if (tickJob?.isActive != true) {
            tickJob = scope.launch {
                while (isActive) {
                    nowMs = System.currentTimeMillis()
                    delay(250)
                }
            }
        }
        if (!started) {
            started = true
            scope.launch { bootLock() }
            scope.launch { loadSettings() }
            // The sport picker is what the console opens on: the current sport pre-highlighted,
            // one tap on it moves on to the game menu.
            scope.launch { loadSportList(); openSportPicker() }
        }
    }

    fun stop() {
        pollJob?.cancel(); pollJob = null
        tickJob?.cancel(); tickJob = null
    }

    // ------------------------------------------------------------------------------ helpers

    private fun now() = System.currentTimeMillis()
    val behind get() = settings.behind
    fun panelSide(screen: String) = Rules.panelSide(screen, behind)
    fun screenSide(panel: String) = Rules.panelSide(panel, behind)
    val ui get() = SportUi.of(sport)
    val state get() = status.state
    val matchOverNow get() = Rules.matchOver(sport, state, settings.bestOf)
    val locked get() = pinRequired && scorerPin.isEmpty()

    private var toastSeq = 0L
    private var toastJob: Job? = null
    private var stickyToast: ToastMsg? = null

    fun toast(msg: String, actionLabel: String? = null, action: (() -> Unit)? = null, sticky: Boolean = false, bad: Boolean = false, calm: Boolean = false, ms: Long = 3_200) {
        val t = ToastMsg(++toastSeq, msg, actionLabel, action, sticky, (sticky && !calm) || bad, ms)
        if (sticky) stickyToast = t
        toast = t
        toastJob?.cancel()
        if (!sticky) toastJob = scope.launch { delay(ms); hideToast() }
    }

    fun hideToast() {
        toastJob?.cancel()
        toast = null
        // A passing note was shown over an unresolved failure: put the failure back.
        val s = stickyToast ?: return
        toastJob = scope.launch { delay(250); if (stickyToast === s) toast = s }
    }

    fun clearStickyToast() {
        val s = stickyToast ?: return
        stickyToast = null
        if (toast?.id == s.id) hideToast()
    }

    fun tapToastAction() {
        val t = toast ?: return
        hideToast()
        t.action?.invoke()
    }

    /** The console's askConfirm: one slot; a confirm that is replaced answers "no". */
    suspend fun askConfirm(msg: String, yes: String = "Confirm", no: String = "Cancel", danger: Boolean = false): Boolean {
        confirm?.answer?.complete(false)
        val d = CompletableDeferred<Boolean>()
        confirm = ConfirmAsk(msg, yes, no, danger, d)
        return d.await()
    }

    fun answerConfirm(yes: Boolean) {
        val c = confirm ?: return
        confirm = null
        c.answer.complete(yes)
    }

    /** Every call: a 403 means the PIN is wrong or missing, wherever it came from. */
    private suspend fun <T> guarded(block: suspend () -> T): T = try {
        block()
    } catch (e: BoardApi.Refused) {
        if (e.status == 403) onPinRejected()
        throw e
    }

    private suspend fun post(path: String, body: JSONObject = JSONObject(), timeoutMs: Int? = null) = guarded { api.post(path, body, timeoutMs) }
    private suspend fun get(path: String, timeoutMs: Int = BoardApi.READ_MS) = guarded { api.get(path, timeoutMs) }

    private fun errText(e: Throwable) = e.message ?: e.javaClass.simpleName
    private fun pinWords(e: Throwable) = Regex("pin", RegexOption.IGNORE_CASE).containsMatchIn(errText(e))

    // ------------------------------------------------------------------------------ status

    private var statusInFlight = false
    private var statusAgain = false
    private var statusSeq = 0L
    private var renderedSeq = 0L
    private var lastState: LiveState? = null
    private var orientSavedAt = 0L

    /**
     * One poll. Single-flight but coalescing: an ask that arrives while a poll is out is re-fired
     * when it lands (sendAction asks right after its POST, to correct the screen).
     */
    suspend fun refreshStatus() {
        if (statusInFlight) { statusAgain = true; return }
        statusInFlight = true
        val seq = ++statusSeq
        var st: JSONObject? = null
        try {
            st = api.get("/api/status")
            lastGoodAt = now()
        } catch (e: Exception) {
            showFrozen()
        } finally {
            statusInFlight = false
            if (statusAgain) { statusAgain = false; scope.launch { refreshStatus() } }
        }
        if (st != null) renderStatus(st, seq)
    }

    /**
     * Replies are applied in the order they were REQUESTED: a poll sent before a +1 must not paint
     * the pre-tap score back over it. No ticket = decided locally, current by definition.
     */
    fun renderStatus(patch: JSONObject, seq: Long? = null) {
        val s = seq ?: ++statusSeq
        if (s < renderedSeq) return
        renderedSeq = s
        val st = status.merge(patch)
        status = st
        st.sport?.let { sp ->
            if (sp != sport) {
                val had = sport
                sport = sp
                applySportUi()
                if (had.isNotEmpty()) scope.launch { loadSettings() }
            }
        }
        // Where the scorer sits rides on every poll, so a change made on another tablet lands here
        // too — but not in the seconds after this tablet saved it (a poll in the air says the old one).
        val o = st.orientation
        if ((o == "behind" || o == "front") && o != settings.orientation && now() - orientSavedAt > 4_000) {
            settings = settings.with("orientation", o)
        }
        setOffline(false)
        if (st.ledboxConnected) offlineDismissed = false
        if (st.uplinkStatus != "portal") uplinkBannerDismissed = false
        lastState = st.state ?: lastState
        renderPrematch(st)
        maybePromptServeOrder(st.state)
        maybeAskEndMatch(st.state)
        pinRequired = st.pinRequired
        if (liveLog != null && st.log?.n != logShownN) refreshLiveLog()
    }

    private fun applySportUi() {
        // A countdown or SET ENDED card belongs to the match of the sport being left.
        clearCountdown()
    }

    private fun setOffline(on: Boolean) {
        if (reachable == !on) return
        reachable = !on
        // Back on a POLL, not a write: the tap that failed is still unaccounted for (it may or may
        // not have landed), so the red toast turns into the next step instead of just vanishing.
        if (!on && stickyToast?.msg?.startsWith("Not sent — board unreachable") == true) {
            stickyToast = null
            toast("Connection back — check the board score, then carry on", sticky = true, calm = true)
        }
    }

    private fun showFrozen() = setOffline(true)

    // ------------------------------------------------------------------------------ actions

    private var actionBusy = false
    private var actionSince = 0L
    private var actionGen = 0L

    fun act(action: JSONObject, key: String? = null) {
        scope.launch { sendAction(action, key) }
    }

    /**
     * One action at a time: on a lagged link a second tap would land too, and one rally would
     * become two points. [key] names the control that was tapped: disabled for the round trip,
     * ringed red if the write fails.
     */
    suspend fun sendAction(action: JSONObject, key: String? = null): JSONObject? {
        if (actionBusy) {
            if (now() - actionSince < BoardApi.WRITE_MS + 2_000) {
                toast("Still sending the last action — that one didn't go through.")
                return null
            }
        }
        val gen = ++actionGen
        actionBusy = true
        actionSince = now()
        busyKey = key
        if (key != null) notSent.remove(key)
        val seq = ++statusSeq
        try {
            val r = post("/api/action", JSONObject().put("action", action))
            if (gen != actionGen) return null
            markSent()
            val s = r.optJSONObject("state")
            val type = action.optString("type")
            val keepsPre = prematchOn && type in Rules.PREMATCH_ACTIONS
            if (s != null && !keepsPre && (boardMode == BoardMode.IDLE || boardMode == BoardMode.CLOCK)) boardMode = BoardMode.MATCH
            val patch = JSONObject()
            if (s != null) patch.put("state", s)
            if (prematchOn && !keepsPre) patch.put("prematch", false)
            if (r.has("canUndo")) { patch.put("canUndo", r.opt("canUndo")); patch.put("undoLabel", r.opt("undoLabel")) }
            if (r.has("log")) patch.put("log", r.opt("log"))
            if (s != null) renderStatus(patch, seq)
            handleEvent(r.optString("event").ifEmpty { null }, s?.let { LiveState(it) })
            scope.launch { refreshStatus() }
            return r
        } catch (e: Exception) {
            if (gen == actionGen) notSentFor(e, key)
            return null
        } finally {
            if (gen == actionGen) {
                actionBusy = false
                busyKey = null
            }
        }
    }

    /**
     * A write that failed. No reply at all: the controller is unreachable, the tap is ringed and a
     * sticky note says so — never "try again", a timed-out write may still have landed. A refusal
     * is the board answering: say why. A 403 has already opened the PIN pad.
     */
    private fun notSentFor(e: Exception, key: String?) {
        if (e is BoardApi.Refused && e.status == 403) { toast(errText(e)); return }
        if (key != null) notSent[key] = true
        if (e !is BoardApi.Refused) {
            showFrozen()
            toast("Not sent — board unreachable. Check the score on the board before tapping again.", sticky = true)
        } else {
            toast("Not sent — " + errText(e), sticky = true)
        }
    }

    private fun markSent() {
        clearStickyToast()
        notSent.clear()
        setOffline(false)
    }

    /** Game-flow reactions the board signals with a point (`handleEvent`). */
    private fun handleEvent(event: String?, s: LiveState?) {
        if (event == null || s == null) return
        when (event) {
            "undo-empty" -> toast("Nothing to undo")
            "undo" -> afterUndo(s)
            "set-closed" -> {
                if (Rules.matchOver(sport, s, settings.bestOf)) {
                    toast("The match is over — start a new game from the game menu"); return
                }
                toast(if (sport == Sport.BASKETBALL) "This period is over — tap End period" else "Set is over — tap Start interval")
                if (sport != Sport.BASKETBALL && countdown == null) showSetEndPrompt(s)
            }
            "set-end" -> {
                flashPoints(s.sideOf(s.pointsA > s.pointsB))
                showSetEndPrompt(s)
            }
            "match-end" -> {
                val winSide = s.sideOf(s.setsA > s.setsB)
                val name = s.sides().team(winSide).short.ifEmpty { screenSide(winSide).uppercase() }
                flashPoints(s.sideOf(s.pointsA > s.pointsB))
                nameFlash[winSide] = (nameFlash[winSide] ?: 0) + 1
                toast("🏆 $name wins the match")
            }
            "switch-due" -> scope.launch { requestCourtSwitch() }
            "tech-timeout" -> startCountdown(
                settings.ttoSeconds, "Technical Time-Out", CdKind.TTO,
                onFinish = { act(JSONObject().put("type", "swap")) },
                major = true, content = "full", action = "End time-out →",
            )
            "bonus" -> toast("Bonus — the opponent shoots free throws")
            "period-end" -> toast(if (s.over) "Game over" else Rules.periodLabel(s.period) + " starting")
            "game-end" -> {
                val winSide = s.sideOf(s.pointsA > s.pointsB)
                val name = s.sides().team(winSide).short.ifEmpty { screenSide(winSide).uppercase() }
                flashPoints(winSide)
                nameFlash[winSide] = (nameFlash[winSide] ?: 0) + 1
                toast("🏆 $name wins")
            }
        }
    }

    private fun flashPoints(panelSide: String) {
        pointFlash[panelSide] = (pointFlash[panelSide] ?: 0) + 1
    }

    // ------------------------------------------------------------------------------ the controls

    private fun sideAction(type: String, panel: String) = JSONObject().put("type", type).put("side", panel)

    /** +/− (and basketball's +1/+2/+3/−1) on the card at SCREEN side [screen]. */
    fun point(screen: String, delta: Int) =
        act(sideAction("point", panelSide(screen)).put("delta", delta), "pt:$screen:$delta")

    /** A typed absolute value (tap a number). Never blinks, never wins a set. */
    fun editValue(screen: String, field: String, name: String) {
        val target = panelSide(screen)
        val team = (state?.sides() ?: return).team(target)
        val type = when (field) { "points" -> "point"; "sets" -> "set"; "to" -> "timeout"; else -> "sub" }
        val current = when (field) { "points" -> team.points; "sets" -> team.sets; "to" -> team.to; else -> team.sub }
        val who = team.short.uppercase().ifEmpty { if (screen == "left") "Left" else "Right" }
        edit = EditAsk("$who $name", current) { v -> act(sideAction(type, target).put("value", v)) }
    }

    /**
     * T/O, sets, subs ±. Timeouts and subs go straight through and offer Undo in the toast; a
     * timeout's clock starts at the tap (the teams are already walking off).
     */
    fun stat(screen: String, stat: String, d: Int) = scope.launch {
        val target = panelSide(screen)
        val nm = (state?.sides()?.team(target)?.short ?: "").ifEmpty { screen }.uppercase()
        val startsClock = stat == "timeout" && d > 0 && settings.countdownOnTimeout
        if (startsClock) {
            startCountdown(settings.timeoutSeconds, "TO $nm", CdKind.TIMEOUT, content = "full", side = target, boardLabel = "TIME OUT")
        }
        val r = sendAction(sideAction(stat, target).put("delta", d), "stat:$screen:$stat:$d")
        val clockUp = { boardMode == BoardMode.COUNTDOWN && countdown?.boardLabel == "TIME OUT" }
        if (r == null) {
            if (startsClock && clockUp()) { clearCountdown(); stopServerCountdown(false) }
            return@launch
        }
        if (stat != "timeout" && stat != "sub") return@launch
        val what = if (stat == "timeout") "Timeout" else if (sport == Sport.BASKETBALL) "Team foul" else "Substitution"
        val step = r.optString("undoLabel")
        val said = (if (d > 0) what else "$what taken back") + " · " + nm
        if (r.opt("canUndo") != true) { toast(said); return@launch }
        toast(said, ms = 6_000, actionLabel = "Undo", action = {
            if (!status.canUndo || status.undoLabel != step) toast("Something else was entered since — use Undo beside the set results.")
            else undo()
        })
    }

    fun serve(screen: String) = act(sideAction("serve", panelSide(screen)), "serve:$screen")
    fun servePlayer() = act(JSONObject().put("type", "serve-player"), "plr")
    fun period(d: Int) = act(sideAction("set", "left").put("delta", d), "period:$d")
    fun swap() = act(JSONObject().put("type", "swap"), "swap")

    fun teamName(screen: String, name: String) =
        act(sideAction("team", panelSide(screen)).put("short", name.uppercase()))

    fun teamColor(screen: String, hex: String) {
        if (TeamColors.parse(hex) == null) return
        act(sideAction("team", panelSide(screen)).put("color", TeamColors.hex(TeamColors.parse(hex)!!)))
    }

    fun pickColor(screen: String) {
        val t = state?.sides()?.team(panelSide(screen))
        colorAsk = ColorAsk(
            (t?.short?.uppercase()?.ifEmpty { null } ?: if (screen == "left") "Left" else "Right") + " colour",
            t?.color ?: "#888888",
        ) { teamColor(screen, it) }
    }

    fun endPeriod() = scope.launch {
        if (sport == Sport.BASKETBALL && askConfirm("End this period?", yes = "End period")) sendAction(JSONObject().put("type", "next-set"))
    }

    fun removeLastSet() = scope.launch {
        if (askConfirm("Remove the last set result?", yes = "Remove set", danger = true)) sendAction(JSONObject().put("type", "remove-set"))
    }

    fun reset() = scope.launch {
        if (askConfirm(Rules.resetWarning(sport), yes = "Reset match", danger = true)) {
            clearCountdown()
            boardMode = BoardMode.MATCH
            sendAction(JSONObject().put("type", "reset"))
        }
    }

    /** The names + VS screen. Any scoring action lifts it. */
    fun idle() = scope.launch {
        try {
            post("/api/idle", JSONObject().put("on", true))
            clearCountdown()
            boardMode = BoardMode.IDLE
            toast("Idle screen on the board")
        } catch (e: Exception) { toast(errText(e)) }
    }

    /** "Show clock": the crest and the time, and it stays the clock. The score is kept. */
    suspend fun showClock(onErr: ((String) -> Unit)? = null): Boolean = try {
        post("/api/idle", JSONObject().put("on", true).put("screen", "clock"))
        clearCountdown()
        boardMode = BoardMode.CLOCK
        scope.launch { refreshStatus() }
        true
    } catch (e: Exception) {
        val m = if (pinWords(e)) "Scoring is locked — enter the scorer PIN, then try again." else "Couldn't show the clock: " + errText(e)
        if (onErr != null) onErr(m) else toast(m)
        false
    }

    fun clockButton() = scope.launch { if (showClock()) toast("Clock on the board") }

    /**
     * Opening the Game tab means "a match is being run now": take the panel off the crest. Through
     * /api/idle, never /api/manual, so a linked LAN match is not dropped. Not from a pre-match —
     * the board takes idle-off as "start the match" — so the status is read fresh first: the tab is
     * often opened by the console the moment it set a pre-match up from the schedule.
     */
    fun enterGameTab() = scope.launch {
        refreshStatus()
        showBoardLive()
        loadSettings()
    }

    private suspend fun showBoardLive() {
        if (prematchOn) return
        try {
            post("/api/idle", JSONObject().put("on", false))
            boardMode = BoardMode.MATCH
        } catch (_: Exception) { /* locked, or down: the PIN pad / offline banner say so */ }
    }

    /** A beach game started from the console's schedule: the serve order, as the console asked it. */
    fun serveOrderFromConsole() = scope.launch {
        beachSeenPoints = false
        beachAskedSets = -1
        refreshStatus()
        openServeOrder()
    }

    // ------------------------------------------------------------------------------ undo

    private var undoAsked = ""

    fun undo() = scope.launch {
        undoAsked = status.undoLabel
        sendAction(JSONObject().put("type", "undo"), "undo")
    }

    /** The board restored the state before the last action: put the screens back to match it. */
    private fun afterUndo(s: LiveState) {
        toast(if (undoAsked.isNotEmpty()) "Undone: $undoAsked" else "Last action undone")
        val cd = countdown
        val running = if (boardMode == BoardMode.COUNTDOWN && cd != null) cd.boardLabel else ""
        if (sport != Sport.BASKETBALL) {
            if (Rules.setIsClosed(s)) {
                // "Start interval" taken back: the finished set is on the board again.
                if (running == "INTERVAL") { clearCountdown(); scope.launch { stopServerCountdown(false) } }
                if (countdown == null) showSetEndPrompt(s)
            } else if (cd?.kind == CdKind.SET_ENDED) {
                // The set-winning point taken back: the set is open again.
                clearCountdown()
            }
        }
        if (undoAsked.startsWith("Timeout") && running == "TIME OUT") { clearCountdown(); scope.launch { stopServerCountdown(false) } }
        if (!Rules.matchOver(sport, s, settings.bestOf) && matchEnd != null) matchEnd = null
    }

    // ------------------------------------------------------------------------------ countdown

    private var cdJob: Job? = null
    private var cdOnFinish: ((Deferred<Unit>) -> Unit)? = null
    private var cdButton: () -> Unit = { finishCountdown(false) }

    fun tapCountdownButton() = cdButton()

    private suspend fun stopServerCountdown(expired: Boolean) {
        try { post("/api/countdown/stop", JSONObject().put("expired", expired)) } catch (_: Exception) {}
    }

    fun clearCountdown() {
        cdJob?.cancel(); cdJob = null
        cdOnFinish = null
        countdown = null
        if (boardMode == BoardMode.COUNTDOWN) boardMode = BoardMode.MATCH
    }

    /** expired = the clock ran out (the board sounds its horn); false on a manual skip. */
    private fun finishCountdown(expired: Boolean) {
        val cb = cdOnFinish
        clearCountdown()
        val stopped = scope.async { stopServerCountdown(expired) }
        cb?.invoke(stopped)
    }

    fun startCountdown(
        seconds: Int,
        label: String,
        kind: CdKind,
        onFinish: ((Deferred<Unit>) -> Unit)? = null,
        major: Boolean = false,
        action: String? = null,
        content: String = "full",
        swapFirst: Boolean = false,
        side: String? = null,
        boardLabel: String? = null,
        blink: Boolean = false,
    ) {
        clearCountdown()
        cdOnFinish = onFinish
        val end = now() + seconds * 1000L
        val bl = (boardLabel ?: label).uppercase()
        countdown = Countdown(kind, label, bl, end, major, action, content, side, blink)
        boardMode = BoardMode.COUNTDOWN
        cdButton = { finishCountdown(false) }
        // Mirrored onto the board, which paints its own countdown screen and sounds the horn.
        // swapFirst (the set interval): the board swaps ends and resets the points atomically and
        // hands back the new state, so the tablet shows the switched sides at once.
        scope.launch {
            val body = JSONObject().put("seconds", seconds).put("label", boardLabel ?: label).put("content", content)
            if (swapFirst) body.put("swapFirst", true)
            if (side != null) body.put("side", side)
            val r = try { post("/api/countdown", body) } catch (_: Exception) { null }
            if (swapFirst) r?.optJSONObject("state")?.let { renderStatus(JSONObject().put("state", it)) }
        }
        cdJob = scope.launch {
            while (isActive) {
                if (now() >= end) {
                    scope.launch { finishCountdown(true) }
                    break
                }
                delay(250)
            }
        }
    }

    /**
     * A set ended: the board holds the final score and this card waits for "Start interval". Only
     * then does the interval clock (and the board's countdown screen) begin.
     */
    private fun showSetEndPrompt(s: LiveState) {
        clearCountdown()
        val sd = s.sides()
        val score = "${sd.team(panelSide("left")).points}–${sd.team(panelSide("right")).points}"
        countdown = Countdown(CdKind.SET_ENDED, "SET ENDED", "SET ENDED", 0L, true, "Start interval →", "full", null, false, score)
        cdButton = {
            if (!settings.countdownOnSetInterval) {
                clearCountdown()
                act(JSONObject().put("type", "next-set"))
            } else {
                startCountdown(settings.setIntervalSeconds, "INTERVAL", CdKind.INTERVAL, major = true,
                    action = "Start next set →", content = "sets", swapFirst = true)
            }
        }
    }

    /**
     * A change of ends is due (beach every 7 / 5, the indoor decider at 8): asked, never automatic.
     * Yes = the panel says COURT SWITCH for ~3 s while the board swaps ends behind it.
     */
    private suspend fun requestCourtSwitch() {
        if (!askConfirm("Switch sides?", yes = "Switch sides")) return
        try {
            val r = post("/api/message", JSONObject().put("text", "COURT SWITCH").put("seconds", 3).put("swap", true))
            r.optJSONObject("state")?.let { renderStatus(JSONObject().put("state", it)) }
            if (r.opt("ok") == false) toast("Sides switched — the board has no announcement screen.")
        } catch (e: Exception) {
            toast("Couldn't announce it: " + errText(e))
        }
    }

    // ------------------------------------------------------------------------------ pre-match

    val warmupRunning get() = boardMode == BoardMode.COUNTDOWN && countdown?.boardLabel == "WARM UP"

    private fun renderPrematch(st: BoardStatus) {
        val on = st.prematch
        val was = prematchOn
        prematchOn = on
        if (!on) {
            // Started elsewhere (another tablet, the warm-up running out): the scoreboard is up.
            if (was && boardMode == BoardMode.CLOCK) boardMode = BoardMode.MATCH
            return
        }
        val names = st.ledboxIdle && st.ledboxClockHeld == false
        if (!warmupRunning && boardMode != BoardMode.COUNTDOWN) boardMode = if (names) BoardMode.IDLE else BoardMode.CLOCK
    }

    /** True when the pre-match panel shows the names (after VS) rather than the held clock. */
    val prematchShowsNames get() = status.ledboxIdle && status.ledboxClockHeld == false

    /** The Warm-up button and the pre-match "Start warm-up": in a pre-match its end starts the match. */
    fun startWarmup() {
        val pre = prematchOn
        startCountdown(
            settings.warmupSeconds, "WARM UP", CdKind.WARMUP,
            onFinish = if (pre) { stopped ->
                boardMode = BoardMode.MATCH
                renderStatus(JSONObject().put("prematch", false))
                scope.launch { stopped.await(); refreshStatus() }
            } else null,
            major = true, action = if (pre) "End warm-up · start match" else "End warm-up", content = "none",
        )
        if (pre) renderPrematch(status)
    }

    var startingMatch by mutableStateOf(false); private set

    fun startMatchNow() = scope.launch {
        startingMatch = true
        try {
            val r = post("/api/prematch", JSONObject().put("action", "start"))
            if (warmupRunning) clearCountdown()
            boardMode = BoardMode.MATCH
            renderStatus(JSONObject(r.toString()).put("prematch", false))
            toast("Match on — the scoreboard is on the board")
        } catch (e: Exception) {
            toast(if (pinWords(e)) "Scoring is locked — enter the scorer PIN, then try again." else "Couldn't start the match: " + errText(e))
        } finally { startingMatch = false }
    }

    // ------------------------------------------------------------------------------ end of match

    private var endAsking = false
    /** The finished state, so the Final chip can reopen the result. */
    var lastFinal by mutableStateOf<LiveState?>(null); private set

    /** Asked exactly once per finished match; declining is an answer too. */
    private fun maybeAskEndMatch(s: LiveState?) {
        if (s == null || endAsking) return
        if (!Rules.matchOver(sport, s, settings.bestOf)) {
            lastFinal = null
            host.endAskedSig = null
            return
        }
        lastFinal = s
        val sig = Rules.matchSig(s)
        if (host.endAskedSig == sig) return
        if (sportPicker != null || gamePicker != null) return
        endAsking = true
        host.endAskedSig = sig
        scope.launch {
            try {
                if (askConfirm("Match finished — show the result?", yes = "Show result", no = "Not now")) showMatchEnd(s)
            } finally { endAsking = false }
        }
    }

    fun showMatchEnd(s: LiveState? = lastFinal) {
        if (s == null) return
        matchEnd = MatchEndUi(s)
        scope.launch { pushResultToBoard(s) }
    }

    fun closeMatchEnd() { matchEnd = null }

    private suspend fun pushResultToBoard(s: LiveState) {
        val lines = Rules.resultLines(sport, s) ?: return
        try {
            val r = post("/api/result", JSONObject().put("winner", lines.winner).put("score", lines.score).put("history", lines.history))
            if (r.opt("ok") == false) matchEnd = matchEnd?.copy(status = "Shown here only — the board has no result screen.", bad = false)
        } catch (e: Exception) {
            matchEnd = matchEnd?.copy(status = "Couldn't put the result on the board: " + errText(e), bad = true)
        }
    }

    fun matchEndNew() = scope.launch {
        if (gameChoice("new") == null) {
            matchEnd = matchEnd?.copy(status = "Couldn't start a new game — try the game menu.", bad = true)
            return@launch
        }
        clearCountdown()
        matchEnd = null
        goToGame()
        if (sport == Sport.BEACH) { beachSeenPoints = false; beachAskedSets = -1; openServeOrder() }
    }

    fun matchEndClock() = scope.launch {
        if (!showClock { m -> matchEnd = matchEnd?.copy(status = m, bad = true) }) return@launch
        matchEnd = null
    }

    // ------------------------------------------------------------------------------ beach serve order

    private var beachSeenPoints = false
    private var beachAskedSets = -1

    fun openServeOrder() {
        val raw = lastState
        serveOrder = ServeOrderUi(
            first = if (raw?.servingTeam == "right") "right" else "left",
            // server_a / server_b are per TEAM; the dialog edits per PANEL side.
            left = if (raw == null) 1 else if ((if (raw.aIsLeft) raw.serverA else raw.serverB) == 2) 2 else 1,
            right = if (raw == null) 1 else if ((if (raw.aIsLeft) raw.serverB else raw.serverA) == 2) 2 else 1,
        )
    }

    fun confirmServeOrder(o: ServeOrderUi) {
        serveOrder = null
        act(JSONObject().put("type", "serve-order").put("first", o.first).put("leftServer", o.left).put("rightServer", o.right))
    }

    /** Asked at the start of each beach set, once, and only after a rally has been played. */
    private fun maybePromptServeOrder(s: LiveState?) {
        if (sport != Sport.BEACH || s == null || serveOrder != null) return
        if (countdown != null) return
        val pts = s.pointsA + s.pointsB
        val sets = s.setsA + s.setsB
        val over = s.setsA >= 2 || s.setsB >= 2
        if (pts > 0) { beachSeenPoints = true; return }
        if (beachSeenPoints && !over && beachAskedSets != sets) {
            beachAskedSets = sets
            beachSeenPoints = false
            openServeOrder()
        }
    }

    // ------------------------------------------------------------------------------ match log

    private var logShownN = -1

    fun openLiveLog() {
        liveLog = LiveLogUi()
        refreshLiveLog()
    }

    fun closeLiveLog() { liveLog = null; logShownN = -1 }

    private fun refreshLiveLog() {
        logShownN = status.log?.n ?: logShownN
        scope.launch {
            val m = try { CurrentMatch.parse(get("/api/history/current")) } catch (_: Exception) { null }
            if (liveLog != null) liveLog = LiveLogUi(m, true)
            if (m != null) logShownN = m.events.size
        }
    }

    // ------------------------------------------------------------------------------ settings

    suspend fun loadSettings() {
        try {
            settings = BoardSettings(get("/api/settings"))
        } catch (_: Exception) { /* keep what we had */ }
    }

    /** The console saved the settings (BRIDGE: settingsChanged): read them again. */
    fun settingsChanged() {
        orientSavedAt = now()
        scope.launch { loadSettings() }
    }

    private val fontBusy = mutableMapOf("left" to false, "right" to false)

    /**
     * −/+ on the name size of one PANEL half, applied at once: the control you reach for BECAUSE
     * the name on the wall is wrong. Patches only this key (the board merges a partial patch).
     */
    fun nudgeFont(screen: String, dir: Int) = scope.launch {
        val side = panelSide(screen)
        if (fontBusy[side] == true) return@launch
        val key = BoardSettings.fontKey(side)
        val cur = settings.fontMax(side)
        val from = cur ?: BoardSettings.FONT_DEFAULT
        val next = (from + dir).coerceIn(BoardSettings.FONT_MIN, BoardSettings.FONT_MAX)
        if (next == cur) return@launch
        fontBusy[side] = true
        val before = settings
        settings = settings.with(key, next)
        fontBump++
        try {
            settings = BoardSettings(post("/api/settings", JSONObject().put(key, next)))
            refreshStatus()
        } catch (e: Exception) {
            settings = before
            toast(errText(e))
        } finally { fontBusy[side] = false }
    }

    // ------------------------------------------------------------------------------ sport + game menu

    private suspend fun loadSportList() {
        try {
            val r = get("/api/sport")
            sports = parseSports(r)
            r.optString("sport").takeIf { it.isNotEmpty() && sport.isEmpty() }?.let { pickerCurrent = it }
        } catch (_: Exception) { }
    }

    private var pickerCurrent = ""
    val curSport get() = sport.ifEmpty { pickerCurrent.ifEmpty { Sport.VOLLEYBALL } }
    fun sportLabel(k: String) = (sports.ifEmpty { Sport.FALLBACK }).firstOrNull { it.key == k }?.label
        ?: k.replaceFirstChar { it.uppercase() }

    fun openSportPicker() { sportPicker = SportPickerUi() }
    fun closeSportPicker() { sportPicker = null }

    fun chooseSport(key: String) = scope.launch {
        if (key == curSport) { closeSportPicker(); openGamePicker(); return@launch }
        sportPicker = SportPickerUi(true, "Switching to ${sportLabel(key)}… the board restarts (about 8 seconds).")
        try {
            val r = post("/api/sport", JSONObject().put("sport", key))
            if (r.opt("changed") == false) {
                renderStatus(get("/api/status"))
                closeSportPicker(); openGamePicker(); return@launch
            }
            val done = waitForSwitch(key)
            if (done != null) {
                loadSettings()
                renderStatus(done)
                closeSportPicker()
                toast(sportLabel(key) + " ready")
                openGamePicker()
            } else {
                sportPicker = SportPickerUi(false, "The board is taking a while to restart — it'll switch on its own once it's back.", true)
            }
        } catch (e: Exception) {
            sportPicker = SportPickerUi(false,
                if (pinWords(e)) "Scoring is locked — enter the scorer PIN, then choose again." else "Couldn't switch: " + errText(e), true)
        }
    }

    /** Across the restart: done once it answers on the new sport and was seen down (or 9 s passed). */
    private suspend fun waitForSwitch(key: String): JSONObject? {
        val t0 = now()
        var sawDown = false
        while (now() - t0 < 25_000) {
            delay(700)
            try {
                val s = api.get("/api/status")
                if (s.optString("sport") == key && (sawDown || now() - t0 > 9_000)) return s
            } catch (_: Exception) { sawDown = true }
        }
        return try { api.get("/api/status") } catch (_: Exception) { null }
    }

    fun sportPickerClock() = scope.launch {
        sportPicker = sportPicker?.copy(busy = true)
        val ok = showClock { m -> sportPicker = SportPickerUi(false, m, true) }
        if (ok) { closeSportPicker(); toast("Clock on the board") } else sportPicker = sportPicker?.copy(busy = false)
    }

    fun sportPickerGameMenu() { closeSportPicker(); scope.launch { openGamePicker() } }

    fun sportPickerDiag() { closeSportPicker(); onShowTab?.invoke("diag", null) }

    suspend fun openGamePicker() {
        closeSportPicker()
        gamePicker = GamePickerUi()
        val saved = try { SavedGame.parse(get("/api/game").optJSONObject("saved")) } catch (_: Exception) { null }
        if (gamePicker != null) gamePicker = gamePicker?.copy(saved = saved, loaded = true)
    }

    fun closeGamePicker() { gamePicker = null }

    private var lastGameChoiceStatus = 0

    private suspend fun gameChoice(choice: String): JSONObject? {
        gamePicker = gamePicker?.copy(busy = true, status = null)
        lastGameChoiceStatus = 0
        return try {
            val r = post("/api/game", JSONObject().put("choice", choice))
            renderStatus(r)
            r
        } catch (e: Exception) {
            lastGameChoiceStatus = (e as? BoardApi.Refused)?.status ?: 0
            gamePicker = gamePicker?.copy(status = if (pinWords(e)) "Scoring is locked — enter the scorer PIN, then choose again."
                else "Couldn't do that: " + errText(e), bad = true)
            null
        } finally {
            gamePicker = gamePicker?.copy(busy = false)
        }
    }

    fun gameContinue() = scope.launch {
        if (gameChoice("continue") == null) {
            if (lastGameChoiceStatus == 404) {
                openGamePicker()
                gamePicker = gamePicker?.copy(status = "That saved game is gone — it was cleared from somewhere else. Start a new one.", bad = true)
            }
            return@launch
        }
        closeGamePicker(); goToGame()
    }

    fun gameNew() = scope.launch {
        val saved = gamePicker?.saved
        if (saved != null && !askConfirm("Start a new game? The saved match (${Rules.describeSaved(saved)}) will be deleted.", yes = "Start new game", danger = true)) return@launch
        if (gameChoice("new") == null) return@launch
        clearCountdown()
        closeGamePicker(); goToGame()
        if (curSport == Sport.BEACH) { beachSeenPoints = false; beachAskedSets = -1; openServeOrder() }
    }

    fun gameDelete() = scope.launch {
        val saved = gamePicker?.saved ?: return@launch
        if (!askConfirm("Delete the saved game? " + Rules.describeSaved(saved), yes = "Delete", danger = true)) return@launch
        val r = gameChoice("delete") ?: return@launch
        gamePicker = gamePicker?.copy(saved = null)
        val cleared = if (r.has("cleared")) r.opt("cleared") == true else (r.optJSONObject("state")?.let { !LiveState(it).hasScore() } ?: false)
        if (cleared) { clearCountdown(); boardMode = BoardMode.CLOCK }
        refreshStatus()
        toast("Saved game deleted")
    }

    fun gameClock() = scope.launch {
        gamePicker = gamePicker?.copy(busy = true, status = null)
        val ok = showClock { m -> gamePicker = gamePicker?.copy(status = m, bad = true) }
        gamePicker = gamePicker?.copy(busy = false)
        if (ok) closeGamePicker()
    }

    /** `goToTab("manual")`: the Game tab, which also takes the panel off the crest (enterGameTab). */
    private fun goToGame() {
        onShowTab?.invoke("game", null)
    }

    // ------------------------------------------------------------------------------ scorer PIN

    private fun savePin(pin: String) {
        scorerPin = pin
        host.scorerPin = pin
    }

    /** From the console (BRIDGE setScorerPin): it learned a PIN, or forgot it. */
    fun pinFromConsole(pin: String) {
        if (pin.length > 8) return
        savePin(pin)
        if (pin.isNotEmpty() && pinPad?.gate == false) pinPad = null
    }

    /** At start: a PIN screen over everything until the board has no PIN or ours still checks out. */
    private suspend fun bootLock() {
        val pinSet = try { get("/api/settings").optBoolean("pinSet", false) } catch (_: Exception) { return }
        if (!pinSet) { offerClock(); return }
        pinRequired = true
        if (scorerPin.isNotEmpty()) {
            try {
                if (post("/api/unlock", JSONObject().put("pin", scorerPin)).optBoolean("ok")) { offerClock(); return }
            } catch (_: Exception) { }
        }
        pinPad = PinPadUi(gate = true)
    }

    fun submitPin(pin: String) = scope.launch {
        val pad = pinPad ?: return@launch
        val p = pin.trim()
        if (p.isEmpty()) return@launch
        pinPad = pad.copy(busy = true, error = null)
        try {
            val r = api.post("/api/unlock", JSONObject().put("pin", p))
            if (r.optBoolean("ok")) {
                savePin(p)
                pinRequired = true
                pinPad = null
                if (!pad.gate) toast("Unlocked — you can score")
                offerClock()
            } else {
                pinPad = pad.copy(busy = false, error = if (pad.gate) "Wrong PIN — try again." else "Wrong PIN")
            }
        } catch (e: Exception) {
            // A lockout is a 429 with a real explanation; say it, never "check the cables".
            pinPad = pad.copy(busy = false, error = if (pinWords(e)) errText(e) else "Couldn't reach the board — try again.")
        }
    }

    fun cancelPinPad() { if (pinPad?.gate == false) pinPad = null }

    /** A rejected write: our PIN is wrong or absent — forget it and ask again. */
    fun onPinRejected() {
        savePin("")
        pinRequired = true
        if (pinPad == null) pinPad = PinPadUi(gate = false)
    }

    /** The header padlock: locked → ask for the PIN; unlocked → hand the tablet on. */
    fun lockButton() = scope.launch {
        if (scorerPin.isEmpty()) { pinPad = PinPadUi(gate = false); return@launch }
        if (!askConfirm("Lock scoring on this device? You'll need the PIN to score again.", yes = "Lock scoring")) return@launch
        savePin("")
        toast("Locked — the PIN is needed to score")
    }

    private var clockOffered = false

    /**
     * The board has no RTC; this tablet does. Epoch ms, never a formatted time. Quiet unless it
     * actually corrected something; `busy` (mid-match) is tried again at the next unlock.
     */
    private suspend fun offerClock() {
        if (clockOffered) return
        clockOffered = true
        try {
            val r = post("/api/clock", JSONObject().put("epochMs", now()))
            if (r.optBoolean("applied")) toast("Board clock corrected — it was ${Rules.fmtOffset(r.optLong("offsetMs"))}")
            if (r.optString("reason") == "busy") clockOffered = false
        } catch (_: Exception) { }
    }
}
