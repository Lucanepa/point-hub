package ch.kscw.pointhub.game

import kotlin.math.ceil
import kotlin.math.max

/*
 * PURE. The Game tab's rules, ported one for one from web/index.html so the native screen and the
 * browser console can never disagree about a set label, a limit colour or who won. Each function
 * names its console twin.
 */

object Sport {
    const val VOLLEYBALL = "volleyball"
    const val BEACH = "beach"
    const val BASKETBALL = "basketball"
    const val SIMPLE = "simple"

    /** The pickable list when the board has not answered GET /api/sport yet (`buildSportList`). */
    val FALLBACK = listOf(
        SportOption(VOLLEYBALL, "Volleyball"), SportOption(BEACH, "Beach volleyball"),
        SportOption(BASKETBALL, "Basketball"), SportOption(SIMPLE, "Simple scoreboard"),
    )
}

/** `SPORT_UI` in the console: labels and which controls each sport has. */
data class SportUi(
    val serveLabel: String,
    val toLabel: String,
    val setLabel: String,
    val subLabel: String,
    val showTo: Boolean,
    val showSet: Boolean,
    val showSub: Boolean,
    val showServe: Boolean,
    /** Name-box placeholders per PANEL side. */
    val teamLeft: String,
    val teamRight: String,
) {
    fun placeholder(panelSide: String) = if (panelSide == "right") teamRight else teamLeft

    companion object {
        private val VOLLEY = SportUi("SERVE", "T/O", "Sets", "Subs", true, true, true, true, "TEAM A", "TEAM B")
        private val ALL = mapOf(
            Sport.VOLLEYBALL to VOLLEY,
            // Beach plays by court position (pairs change ends at a fixed board), hence L / R.
            Sport.BEACH to SportUi("SERVE", "T/O", "Sets", "Subs", true, true, false, true, "TEAM L", "TEAM R"),
            // The period is one shared value, shown in the centre, not on each card.
            Sport.BASKETBALL to SportUi("POSS.", "T/O", "Period", "Fouls", true, false, true, true, "TEAM A", "TEAM B"),
            Sport.SIMPLE to SportUi("SERVE", "T/O", "Sets", "Subs", false, false, false, false, "LEFT", "RIGHT"),
        )

        fun of(sport: String?): SportUi = ALL[sport] ?: VOLLEY
    }
}

enum class Limit { NONE, WARN, MAXED }

object Rules {
    /** Basketball's team-foul bonus threshold (matches the board's source). */
    const val BONUS_AT = 5

    private val ROMAN = listOf("", "I", "II", "III", "IV", "V", "VI", "VII")
    fun roman(n: Int): String = ROMAN.getOrNull(n)?.takeIf { it.isNotEmpty() } ?: n.toString()

    /** Q1–Q4, then OT1, OT2… */
    fun periodLabel(p: Int): String {
        val n = if (p <= 0) 1 else p
        return if (n <= 4) "Q$n" else "OT${n - 4}"
    }

    /**
     * Where the scorer sits. Behind the board (the default) the scorer's left is the panel's
     * right, so the cards are mirrored; in front they copy the panel. A mirror is its own inverse,
     * so the same function maps screen → panel and panel → screen (`panelSide` / `screenSide`).
     */
    fun panelSide(screen: String, behind: Boolean): String =
        if (behind) (if (screen == "left") "right" else "left") else (if (screen == "right") "right" else "left")

    fun other(side: String) = if (side == "left") "right" else "left"

    /** Sets needed to win: beach is best of 3; otherwise the best-of setting (default 5 → 3). */
    fun winSets(sport: String?, bestOf: Int): Int = if (sport == Sport.BEACH) 2 else if (bestOf == 3) 2 else 3

    fun matchOver(sport: String?, state: LiveState?, bestOf: Int): Boolean {
        if (state == null) return false
        if (sport == Sport.BASKETBALL) return state.over
        val w = winSets(sport, bestOf)
        return state.setsA >= w || state.setsB >= w
    }

    /** The header chip: "Set III", "Final", "Q2", "FINAL", or nothing (simple). */
    fun setLabel(sport: String?, state: LiveState?, bestOf: Int): String {
        if (state == null) return ""
        if (sport == Sport.SIMPLE) return ""
        if (sport == Sport.BASKETBALL) return if (state.over) "FINAL" else periodLabel(state.period)
        if (matchOver(sport, state, bestOf)) return "Final"
        val win = winSets(sport, bestOf)
        return "Set " + roman(minOf(win * 2 - 1, state.setsA + state.setsB + 1))
    }

    /** Beach court-change cue: every 7 points (sum) in sets 1-2, every 5 in the decider. */
    fun switchDue(s: Sides?): Boolean {
        if (s == null) return false
        val cadence = if (s.left.sets == 1 && s.right.sets == 1) 5 else 7
        val total = s.left.points + s.right.points
        return total > 0 && total % cadence == 0
    }

    fun limit(value: Int, warnAt: Int, maxAt: Int): Limit = when {
        value >= maxAt -> Limit.MAXED
        value >= warnAt -> Limit.WARN
        else -> Limit.NONE
    }

    /** The limit colour of the T/O tile (`renderBoard`): red at the per-sport total, no amber. */
    fun timeoutLimit(sport: String?, settings: BoardSettings, n: Int): Limit {
        val total = settings.totalTimeouts ?: defaultTimeouts(sport)
        return limit(n, total, total)
    }

    /** Subs amber one short of the total and red at it; basketball fouls amber at 4, red at 5. */
    fun subLimit(sport: String?, settings: BoardSettings, n: Int): Limit =
        if (sport == Sport.BASKETBALL) limit(n, BONUS_AT - 1, BONUS_AT)
        else limit(n, settings.totalSubs - 1, settings.totalSubs)

    fun defaultTimeouts(sport: String?) = when (sport) {
        Sport.BEACH -> 1
        Sport.BASKETBALL -> 5
        else -> 2
    }

    /** "M:SS", or bare seconds under a minute is the BOARD's format; the console shows M:SS always. */
    fun fmtCountdown(seconds: Double): String {
        val s = max(0, ceil(seconds).toInt())
        return "${s / 60}:" + (s % 60).toString().padStart(2, '0')
    }

    /** The finished set still on the board: the score is exactly the last recorded result. */
    fun setIsClosed(state: LiveState?): Boolean {
        val last = state?.setResults?.lastOrNull() ?: return false
        return (last.a > 0 || last.b > 0) && last.a == state.pointsA && last.b == state.pointsB
    }

    /** What identifies a finished match, so "show the result?" is asked once per match. */
    fun matchSig(s: LiveState): String = listOf(
        s.teamAShort.ifEmpty { s.teamAName }, s.teamBShort.ifEmpty { s.teamBName },
        s.setsA.toString(), s.setsB.toString(),
        s.setResults.joinToString(",") { "${it.a}:${it.b}" },
    ).joinToString("|")

    /** What decides the match: sets, or in basketball the running score (`matchTally`). */
    fun tally(sport: String?, s: LiveState): Pair<Int, Int> =
        if (sport == Sport.BASKETBALL) s.pointsA to s.pointsB else s.setsA to s.setsB

    data class ResultLines(val winner: String, val score: String, val history: String)

    /** The three lines for the panel's result screen, winner first (`resultLines`); null = a draw. */
    fun resultLines(sport: String?, s: LiveState): ResultLines? {
        val nameA = s.teamAShort.ifEmpty { s.teamAName }.ifEmpty { "TEAM A" }.uppercase()
        val nameB = s.teamBShort.ifEmpty { s.teamBName }.ifEmpty { "TEAM B" }.uppercase()
        val (a, b) = tally(sport, s)
        if (a == b) return null
        val aWon = a > b
        val history = if (sport == Sport.BASKETBALL) "" else
            s.setResults.joinToString("  ") { if (aWon) "${it.a}-${it.b}" else "${it.b}-${it.a}" }
        return ResultLines(
            winner = (if (aWon) nameA else nameB) + " WINS",
            score = (if (aWon) a else b).toString() + " - " + (if (aWon) b else a),
            history = history,
        )
    }

    /** One line of the play-by-play, in the operator's words (`eventText`). */
    fun eventText(e: LogEntry, teamA: String?, teamB: String?): String {
        val who = if (e.side == "b") (teamB?.ifEmpty { null } ?: "B") else (teamA?.ifEmpty { null } ?: "A")
        val n = e.delta ?: 0
        return when (e.type) {
            "point" -> if (n < 0) "Point removed · $who" else if (e.value != null) "$who set to ${e.value}" else "Point · $who"
            "timeout" -> (if (n < 0) "Timeout taken back · " else "Timeout · ") + who
            "sub" -> (if (n < 0) "Substitution taken back · " else "Substitution · ") + who
            "set" -> if (e.value != null) "$who sets set to ${e.value}" else (if (n < 0) "Set taken back · $who" else "Set · $who")
            "serve" -> "Serve · $who"
            "swap" -> "Ends changed"
            "switch-due" -> "Court switch due"
            "remove-set" -> "Set removed"
            "set-end" -> "End of set " + (e.set?.toString() ?: "") + (e.score?.let { " (${it.first}–${it.second})" } ?: "")
            "match-end" -> "Match over"
            "period-end" -> "End of " + periodLabel(e.period ?: 1) + (e.score?.let { " (${it.first}–${it.second})" } ?: "")
            "undo" -> if (!e.what.isNullOrEmpty()) "Undone: ${e.what}" else "Last action undone"
            "set-closed" -> "Point refused · $who — the set was already over"
            else -> e.type
        }
    }

    fun logScore(e: LogEntry?): String = e?.score?.let { "${it.first}–${it.second}" } ?: ""

    /** One line an operator recognises a saved match by (`describeSaved`). */
    fun describeSaved(s: SavedGame): String {
        val sets = if (s.setsA != 0 || s.setsB != 0) "  ·  sets ${s.setsA}–${s.setsB}" else ""
        val whenSaved = s.updatedAt?.let { "  ·  $it" } ?: ""
        return "${s.teamA} ${s.pointsA}–${s.pointsB} ${s.teamB}$sets$whenSaved"
    }

    /** The Reset confirm, in each sport's own words. */
    fun resetWarning(sport: String?): String {
        val lost = " An unfinished match will not appear in History."
        return when (sport) {
            Sport.SIMPLE -> "Reset to 0–0? Both scores are cleared."
            Sport.BASKETBALL -> "Reset to 0–0? The score, period, timeouts and fouls for this game are cleared.$lost"
            Sport.BEACH -> "Reset to 0–0? Scores, sets and timeouts for this match are cleared.$lost"
            else -> "Reset to 0–0? Scores, sets, timeouts and subs for this match are cleared.$lost"
        }
    }

    /** Setting the teams up keeps a pre-match on the clock; anything that scores starts it. */
    val PREMATCH_ACTIONS = setOf("team", "serve", "serve-order", "serve-player", "swap", "undo")

    /** How long a clock offset reads ("12 min behind"), for the "board clock corrected" note. */
    fun fmtOffset(ms: Long): String {
        val s = kotlin.math.abs(ms) / 1000.0
        val dir = if (ms > 0) "behind" else "ahead"
        return when {
            s < 5400 -> "${Math.round(s / 60)} min $dir"
            s < 172800 -> "${Math.round(s / 3600)} h $dir"
            else -> "${Math.round(s / 86400)} days $dir"
        }
    }

    /** The scorer PIN's shape, checked before sending (the board's own rule). */
    val PIN_RE = Regex("^\\d{1,8}$")
}
