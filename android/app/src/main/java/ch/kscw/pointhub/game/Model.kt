package ch.kscw.pointhub.game

import org.json.JSONArray
import org.json.JSONObject

/*
 * PURE. The board's JSON, read the way web/index.html reads it. Every field is optional on the
 * wire (an older board leaves some out, a fresh one has no state at all), so every reader has a
 * default and nothing here throws on a missing or mistyped key.
 */

/** `num()` in the console: a list counts its entries (timeouts/subs are arrays on a linked match). */
internal fun JSONObject.count(key: String): Int = when (val v = opt(key)) {
    is JSONArray -> v.length()
    is Number -> v.toInt()
    is String -> v.trim().toDoubleOrNull()?.toInt() ?: 0
    is Boolean -> if (v) 1 else 0
    else -> 0
}

/** A string, or null for a missing / JSON-null / non-string value. */
internal fun JSONObject.str(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return when (val v = opt(key)) {
        is String -> v
        is Number, is Boolean -> v.toString()
        else -> null
    }
}

internal fun JSONObject.bool(key: String): Boolean = optBoolean(key, false)

/** One team as the PANEL shows it (left or right half of the board, not a side of the tablet). */
data class Team(
    val short: String,
    val color: String,
    val points: Int,
    val sets: Int,
    val to: Int,
    val sub: Int,
)

/** The state projected onto panel halves (`sides()` in the console). */
data class Sides(
    val left: Team,
    val right: Team,
    /** "left" | "right" | null — a PANEL side. */
    val serving: String?,
    /** Beach: the serving player (1|2), 0 elsewhere. */
    val servePlayer: Int,
    /** Basketball: the period (1-4, 5+ = overtime) and whether the game is over. */
    val period: Int,
    val over: Boolean,
) {
    fun team(panelSide: String): Team = if (panelSide == "right") right else left
}

/** One completed set (or, in basketball, the cumulative score at the end of a period). */
data class SetResult(val a: Int, val b: Int)

/**
 * The board's live state in its own a/b terms (`state` in /api/status). Wraps the JSON so fields
 * this app does not model (server_a, match_status, …) survive untouched.
 */
class LiveState(val json: JSONObject) {
    val teamAShort get() = json.str("team_a_short") ?: ""
    val teamBShort get() = json.str("team_b_short") ?: ""
    val teamAName get() = json.str("team_a_name") ?: ""
    val teamBName get() = json.str("team_b_name") ?: ""
    val teamAColor get() = json.str("team_a_color")
    val teamBColor get() = json.str("team_b_color")
    val pointsA get() = json.count("points_a")
    val pointsB get() = json.count("points_b")
    val setsA get() = json.count("sets_won_a")
    val setsB get() = json.count("sets_won_b")
    /** `side_a`: which panel half team A stands on. Anything but "right" is left. */
    val aIsLeft get() = json.str("side_a") != "right"
    val servingTeam get() = json.str("serving_team")
    val servePlayer get() = json.count("serve_player")
    val serverA get() = json.count("server_a")
    val serverB get() = json.count("server_b")
    val period get() = json.count("period").let { if (it <= 0) 1 else it }
    val over get() = json.bool("over")
    val setResults: List<SetResult>
        get() {
            val arr = json.optJSONArray("set_results") ?: return emptyList()
            return (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let { SetResult(it.count("a"), it.count("b")) }
            }
        }

    /** Anything on the scoreboard worth losing: a point or a set on either side. */
    fun hasScore(): Boolean = pointsA + pointsB + setsA + setsB > 0

    fun sides(): Sides {
        val a = Team(
            short = teamAShort, color = teamAColor ?: "#2563eb",
            points = pointsA, sets = setsA, to = json.count("timeouts_a"), sub = json.count("subs_a"),
        )
        val b = Team(
            short = teamBShort, color = teamBColor ?: "#ef4444",
            points = pointsB, sets = setsB, to = json.count("timeouts_b"), sub = json.count("subs_b"),
        )
        return Sides(
            left = if (aIsLeft) a else b,
            right = if (aIsLeft) b else a,
            serving = servingTeam?.takeIf { it == "left" || it == "right" },
            servePlayer = servePlayer,
            period = period,
            over = over,
        )
    }

    /** The PANEL side the a-or-b winner stands on (`sideOf` in the console). */
    fun sideOf(aWins: Boolean): String = if (aWins == aIsLeft) "left" else "right"

    override fun equals(other: Any?): Boolean = other is LiveState && other.json.toString() == json.toString()
    override fun hashCode(): Int = json.toString().hashCode()
}

/** One entry of the match log (`log.last` on every status, the whole list on /api/history/current). */
data class LogEntry(
    val t: String,
    val type: String,
    /** "a" | "b" | null. */
    val side: String?,
    val delta: Int?,
    val value: Int?,
    val score: Pair<Int, Int>?,
    val set: Int?,
    val period: Int?,
    val what: String?,
) {
    companion object {
        fun parse(o: JSONObject): LogEntry {
            val sc = o.optJSONArray("score")
            return LogEntry(
                t = o.str("t") ?: "",
                type = o.str("type") ?: "",
                side = o.str("side"),
                delta = if (o.has("delta") && !o.isNull("delta")) o.count("delta") else null,
                value = if (o.has("value") && !o.isNull("value")) o.count("value") else null,
                score = if (sc != null && sc.length() >= 2) sc.optInt(0) to sc.optInt(1) else null,
                set = if (o.has("set") && !o.isNull("set")) o.count("set") else null,
                period = if (o.has("period") && !o.isNull("period")) o.count("period") else null,
                what = o.str("what"),
            )
        }
    }
}

data class LiveLog(val n: Int, val last: LogEntry, val teamA: String?, val teamB: String?)

/** A game saved on the board for the active sport (GET /api/game → saved). */
data class SavedGame(
    val teamA: String,
    val teamB: String,
    val pointsA: Int,
    val pointsB: Int,
    val setsA: Int,
    val setsB: Int,
    val updatedAt: String?,
) {
    companion object {
        fun parse(o: JSONObject?): SavedGame? {
            if (o == null) return null
            val teams = o.optJSONObject("teams") ?: JSONObject()
            val points = o.optJSONObject("points") ?: JSONObject()
            val sets = o.optJSONObject("sets") ?: JSONObject()
            return SavedGame(
                teamA = teams.str("a") ?: "", teamB = teams.str("b") ?: "",
                pointsA = points.count("a"), pointsB = points.count("b"),
                setsA = sets.count("a"), setsB = sets.count("b"),
                updatedAt = o.str("updatedAt"),
            )
        }
    }
}

/**
 * The merged /api/status. The console keeps ONE last status and merges every reply over it
 * (`{...LAST_STATUS, ...st}`): an action's reply carries only state/undo/log, and must not blank
 * the sport, the PIN flag or the mode. [merge] is that, on the raw JSON; the getters read it.
 */
class BoardStatus(val json: JSONObject = JSONObject()) {
    fun merge(patch: JSONObject): BoardStatus {
        val out = JSONObject(json.toString())
        for (k in patch.keys()) out.put(k, patch.opt(k))
        return BoardStatus(out)
    }

    val mode get() = json.str("mode")
    val matchId get() = json.str("matchId")
    val sport get() = json.str("sport")
    val prematch get() = json.opt("prematch") == true
    val orientation get() = json.str("orientation")
    val pinRequired get() = json.bool("pinRequired")
    val build get() = json.str("build")
    val gameId get() = json.str("gameId")
    val state: LiveState? get() = json.optJSONObject("state")?.let { LiveState(it) }
    val canUndo get() = json.opt("canUndo") == true
    val undoLabel get() = json.str("undoLabel") ?: ""
    val hasUndoFields get() = json.has("canUndo")

    val ledboxConnected get() = json.optJSONObject("ledbox")?.bool("connected") ?: false
    val ledboxHost get() = json.optJSONObject("ledbox")?.str("host")
    val ledboxPort get() = json.optJSONObject("ledbox")?.str("port")
    val ledboxIdle get() = json.optJSONObject("ledbox")?.bool("idle") ?: false
    /** null = the board did not say (an older board). */
    val ledboxClockHeld: Boolean? get() = json.optJSONObject("ledbox")?.let { if (it.has("clockHeld")) it.bool("clockHeld") else null }

    val uplinkStatus get() = json.optJSONObject("uplink")?.str("status")
    val uplinkValidUntil get() = json.optJSONObject("uplink")?.str("validUntil")

    /** The name size the board paints per PANEL side, after its shrink-to-fit; null if not sent. */
    fun boardFontsize(panelSide: String): Int? {
        val fs = json.optJSONObject("board")?.optJSONObject("fontsize") ?: return null
        val n = fs.count(panelSide)
        return if (n > 0) n else null
    }

    val log: LiveLog?
        get() {
            val l = json.optJSONObject("log") ?: return null
            val last = l.optJSONObject("last") ?: return null
            return LiveLog(l.count("n"), LogEntry.parse(last), l.str("team_a"), l.str("team_b"))
        }
}

/**
 * The board's settings (GET/POST /api/settings), read with the console's defaults. The raw JSON is
 * kept: a font nudge patches one key and adopts whatever the board echoes back.
 */
class BoardSettings(val json: JSONObject = JSONObject()) {
    private fun int(key: String, dflt: Int): Int {
        val n = json.count(key)
        return if (json.has(key) && n > 0) n else dflt
    }

    val sport get() = json.str("sport")
    val orientation get() = json.str("orientation") ?: "behind"
    val behind get() = orientation != "front"
    val pinSet get() = json.bool("pinSet")
    val bestOf get() = int("bestOf", 5)
    val totalTimeouts: Int? get() = if (json.has("totalTimeouts") && json.count("totalTimeouts") > 0) json.count("totalTimeouts") else null
    val totalSubs get() = int("totalSubs", 6)
    val timeoutSeconds get() = int("timeoutSeconds", 30)
    val setIntervalSeconds get() = int("setIntervalSeconds", 180)
    val warmupSeconds get() = int("warmupSeconds", 600)
    val ttoSeconds get() = int("ttoSeconds", 60)
    /** Only an explicit false turns these off, as in the console (`!== false`). */
    val countdownOnTimeout get() = json.opt("countdownOnTimeout") != false
    val countdownOnSetInterval get() = json.opt("countdownOnSetInterval") != false
    val branding get() = json.str("branding") ?: "kscw"
    /** "off" when the board does not publish to /live (the banners then say so). */
    val liveScoring get() = json.str("liveScoring")

    /** The −/+ ceiling for one PANEL half's team name, or null when the board has none set. */
    fun fontMax(panelSide: String): Int? {
        val k = fontKey(panelSide)
        return if (json.has(k) && json.count(k) > 0) json.count(k) else null
    }

    fun with(key: String, value: Any): BoardSettings = BoardSettings(JSONObject(json.toString()).put(key, value))

    companion object {
        fun fontKey(panelSide: String) = if (panelSide == "right") "matchFontMaxRight" else "matchFontMaxLeft"
        /** The Settings tab's <input min max> for the name sizes. */
        const val FONT_MIN = 10
        const val FONT_MAX = 30
        const val FONT_DEFAULT = 18
    }
}

/** A sport the board offers (GET /api/sport → sports). */
data class SportOption(val key: String, val label: String)

fun parseSports(o: JSONObject?): List<SportOption> {
    val arr = o?.optJSONArray("sports") ?: return emptyList()
    return (0 until arr.length()).mapNotNull { i ->
        val s = arr.optJSONObject(i) ?: return@mapNotNull null
        val key = s.str("key") ?: return@mapNotNull null
        SportOption(key, s.str("label") ?: key)
    }
}

/** The whole log of the match in progress (GET /api/history/current → match). */
data class CurrentMatch(val teamA: String?, val teamB: String?, val events: List<LogEntry>) {
    companion object {
        fun parse(o: JSONObject?): CurrentMatch? {
            val m = o?.optJSONObject("match") ?: return null
            val arr = m.optJSONArray("events") ?: JSONArray()
            return CurrentMatch(
                m.str("team_a"), m.str("team_b"),
                (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let { LogEntry.parse(it) } },
            )
        }
    }
}
