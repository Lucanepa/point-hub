package ch.kscw.pointhub.game

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RulesTest {
    private fun state(vararg kv: Pair<String, Any>) = LiveState(JSONObject().apply { kv.forEach { (k, v) -> put(k, v) } })
    private fun results(vararg ab: Pair<Int, Int>) = JSONArray().apply { ab.forEach { (a, b) -> put(JSONObject().put("a", a).put("b", b)) } }

    @Test fun behindTheBoardMirrorsTheCards() {
        assertEquals("right", Rules.panelSide("left", behind = true))
        assertEquals("left", Rules.panelSide("right", behind = true))
        assertEquals("left", Rules.panelSide("left", behind = false))
        assertEquals("right", Rules.panelSide("right", behind = false))
        // A mirror is its own inverse.
        for (b in listOf(true, false)) for (s in listOf("left", "right")) assertEquals(s, Rules.panelSide(Rules.panelSide(s, b), b))
    }

    @Test fun setLabels() {
        assertEquals("", Rules.setLabel(Sport.VOLLEYBALL, null, 5))
        assertEquals("Set I", Rules.setLabel(Sport.VOLLEYBALL, state(), 5))
        assertEquals("Set III", Rules.setLabel(Sport.VOLLEYBALL, state("sets_won_a" to 1, "sets_won_b" to 1), 5))
        assertEquals("Set V", Rules.setLabel(Sport.VOLLEYBALL, state("sets_won_a" to 2, "sets_won_b" to 2), 5))
        assertEquals("Final", Rules.setLabel(Sport.VOLLEYBALL, state("sets_won_a" to 3, "sets_won_b" to 1), 5))
        // Best of 3: two sets win, the decider is III.
        assertEquals("Final", Rules.setLabel(Sport.VOLLEYBALL, state("sets_won_a" to 2), 3))
        assertEquals("Set III", Rules.setLabel(Sport.VOLLEYBALL, state("sets_won_a" to 1, "sets_won_b" to 1), 3))
        // Beach is always best of 3, whatever the setting.
        assertEquals("Final", Rules.setLabel(Sport.BEACH, state("sets_won_b" to 2), 5))
        assertEquals("Q3", Rules.setLabel(Sport.BASKETBALL, state("period" to 3), 5))
        assertEquals("OT1", Rules.setLabel(Sport.BASKETBALL, state("period" to 5), 5))
        assertEquals("FINAL", Rules.setLabel(Sport.BASKETBALL, state("period" to 4, "over" to true), 5))
        assertEquals("", Rules.setLabel(Sport.SIMPLE, state("sets_won_a" to 1), 5))
    }

    @Test fun timeoutsAndSubsArriveAsCountsOrLists() {
        val s = state("timeouts_a" to JSONArray().put(1).put(2), "subs_b" to 4, "points_a" to "7").sides()
        assertEquals(2, s.left.to)
        assertEquals(4, s.right.sub)
        assertEquals(7, s.left.points)
    }

    @Test fun sideAPutsTeamAOnTheRight() {
        val s = state("side_a" to "right", "team_a_short" to "KSCW", "team_b_short" to "VOLERO", "points_a" to 5, "points_b" to 3).sides()
        assertEquals("VOLERO", s.left.short)
        assertEquals("KSCW", s.right.short)
        assertEquals(5, s.right.points)
        assertEquals("right", state("side_a" to "right").sideOf(aWins = true))
        assertEquals("left", state().sideOf(aWins = true))
    }

    @Test fun limits() {
        val st = BoardSettings(JSONObject().put("totalSubs", 6))
        assertEquals(Limit.NONE, Rules.subLimit(Sport.VOLLEYBALL, st, 4))
        assertEquals(Limit.WARN, Rules.subLimit(Sport.VOLLEYBALL, st, 5))
        assertEquals(Limit.MAXED, Rules.subLimit(Sport.VOLLEYBALL, st, 6))
        assertEquals(Limit.NONE, Rules.timeoutLimit(Sport.VOLLEYBALL, st, 1))
        assertEquals(Limit.MAXED, Rules.timeoutLimit(Sport.VOLLEYBALL, st, 2))
        // Beach has one timeout, basketball five; fouls amber at 4, red at 5.
        assertEquals(Limit.MAXED, Rules.timeoutLimit(Sport.BEACH, BoardSettings(), 1))
        assertEquals(Limit.NONE, Rules.timeoutLimit(Sport.BASKETBALL, BoardSettings(), 4))
        assertEquals(Limit.WARN, Rules.subLimit(Sport.BASKETBALL, st, 4))
        assertEquals(Limit.MAXED, Rules.subLimit(Sport.BASKETBALL, st, 5))
        // A board's own total wins over the sport default.
        assertEquals(Limit.NONE, Rules.timeoutLimit(Sport.VOLLEYBALL, BoardSettings(JSONObject().put("totalTimeouts", 3)), 2))
    }

    @Test fun beachSwitchCue() {
        fun s(a: Int, b: Int, sa: Int = 0, sb: Int = 0) = state("points_a" to a, "points_b" to b, "sets_won_a" to sa, "sets_won_b" to sb).sides()
        assertFalse(Rules.switchDue(s(0, 0)))
        assertTrue(Rules.switchDue(s(4, 3)))
        assertFalse(Rules.switchDue(s(4, 4)))
        assertTrue(Rules.switchDue(s(9, 5)))
        // The decider changes ends every 5.
        assertTrue(Rules.switchDue(s(3, 2, 1, 1)))
        assertFalse(Rules.switchDue(s(4, 3, 1, 1)))
    }

    @Test fun setClosedIsTheLastResultStillOnTheBoard() {
        assertTrue(Rules.setIsClosed(state("points_a" to 25, "points_b" to 20, "set_results" to results(25 to 20))))
        assertFalse(Rules.setIsClosed(state("points_a" to 0, "points_b" to 0, "set_results" to results(25 to 20))))
        assertFalse(Rules.setIsClosed(state()))
    }

    @Test fun resultLinesWinnerFirst() {
        val s = state("team_a_short" to "kscw", "team_b_short" to "Volero", "sets_won_a" to 1, "sets_won_b" to 3,
            "set_results" to results(25 to 20, 18 to 25, 20 to 25, 22 to 25))
        val r = Rules.resultLines(Sport.VOLLEYBALL, s)!!
        assertEquals("VOLERO WINS", r.winner)
        assertEquals("3 - 1", r.score)
        assertEquals("20-25  25-18  25-20  25-22", r.history)
        assertNull(Rules.resultLines(Sport.VOLLEYBALL, state("sets_won_a" to 1, "sets_won_b" to 1)))
        // Basketball is decided by points, with no set history line.
        val b = Rules.resultLines(Sport.BASKETBALL, state("points_a" to 70, "points_b" to 64, "over" to true))!!
        assertEquals("TEAM A WINS", b.winner)
        assertEquals("70 - 64", b.score)
        assertEquals("", b.history)
    }

    @Test fun matchSignatureSeesTheSetScores() {
        val a = state("team_a_short" to "A", "team_b_short" to "B", "sets_won_a" to 3, "set_results" to results(25 to 1, 25 to 2, 25 to 3))
        val b = state("team_a_short" to "A", "team_b_short" to "B", "sets_won_a" to 3, "set_results" to results(25 to 4, 25 to 2, 25 to 3))
        assertFalse(Rules.matchSig(a) == Rules.matchSig(b))
        assertEquals(Rules.matchSig(a), Rules.matchSig(LiveState(JSONObject(a.json.toString()))))
    }

    @Test fun eventWording() {
        fun e(type: String, side: String? = "a", delta: Int? = 1, value: Int? = null, what: String? = null, score: Pair<Int, Int>? = null) =
            LogEntry("19:42:05", type, side, delta, value, score, 2, 3, what)
        assertEquals("Point · KSCW", Rules.eventText(e("point"), "KSCW", "VOLERO"))
        assertEquals("Point removed · VOLERO", Rules.eventText(e("point", "b", -1), "KSCW", "VOLERO"))
        assertEquals("KSCW set to 12", Rules.eventText(e("point", value = 12), "KSCW", "VOLERO"))
        assertEquals("Timeout taken back · KSCW", Rules.eventText(e("timeout", delta = -1), "KSCW", "VOLERO"))
        assertEquals("End of set 2 (25–20)", Rules.eventText(e("set-end", score = 25 to 20), "KSCW", "VOLERO"))
        assertEquals("End of Q3 (54–48)", Rules.eventText(e("period-end", score = 54 to 48), null, null))
        assertEquals("Undone: Point KSCW", Rules.eventText(e("undo", what = "Point KSCW"), "KSCW", "VOLERO"))
        assertEquals("Point · A", Rules.eventText(e("point"), null, null))
        assertEquals("25–20", Rules.logScore(e("set-end", score = 25 to 20)))
    }

    @Test fun countdownClock() {
        assertEquals("0:30", Rules.fmtCountdown(30.0))
        assertEquals("0:30", Rules.fmtCountdown(29.2))
        assertEquals("3:00", Rules.fmtCountdown(180.0))
        assertEquals("0:00", Rules.fmtCountdown(-4.0))
    }

    @Test fun clockOffsetWording() {
        assertEquals("12 min behind", Rules.fmtOffset(12 * 60_000L))
        assertEquals("36 h ahead", Rules.fmtOffset(-36 * 3_600_000L))
        assertEquals("3 days behind", Rules.fmtOffset(3 * 86_400_000L))
    }

    @Test fun savedGameLine() {
        val g = SavedGame.parse(JSONObject("""{"teams":{"a":"KSCW","b":"VOLERO"},"points":{"a":12,"b":10},"sets":{"a":1,"b":0},"updatedAt":"19:40"}"""))!!
        assertEquals("KSCW 12–10 VOLERO  ·  sets 1–0  ·  19:40", Rules.describeSaved(g))
    }

    @Test fun statusMergeKeepsWhatAReplyLeavesOut() {
        val full = BoardStatus(JSONObject("""{"sport":"beach","pinRequired":true,"mode":"manual","state":{"points_a":1}}"""))
        val merged = full.merge(JSONObject().put("state", JSONObject().put("points_a", 2)).put("canUndo", true).put("undoLabel", "Point A"))
        assertEquals("beach", merged.sport)
        assertTrue(merged.pinRequired)
        assertEquals(2, merged.state!!.pointsA)
        assertTrue(merged.canUndo)
        assertEquals("Point A", merged.undoLabel)
        // The original is untouched.
        assertEquals(1, full.state!!.pointsA)
    }

    @Test fun liveLogOffTheStatus() {
        val st = BoardStatus(JSONObject("""{"log":{"n":7,"last":{"t":"19:42:05","type":"timeout","side":"b","delta":1,"score":[12,10]},"team_a":"KSCW","team_b":"VOLERO"}}"""))
        val l = st.log!!
        assertEquals(7, l.n)
        assertEquals("Timeout · VOLERO", Rules.eventText(l.last, l.teamA, l.teamB))
        assertNull(BoardStatus(JSONObject().put("log", JSONObject.NULL)).log)
    }

    @Test fun settingsDefaults() {
        val s = BoardSettings()
        assertTrue(s.behind)
        assertEquals(30, s.timeoutSeconds)
        assertEquals(180, s.setIntervalSeconds)
        assertTrue(s.countdownOnTimeout)
        assertNull(s.fontMax("left"))
        val t = BoardSettings(JSONObject().put("orientation", "front").put("countdownOnTimeout", false).put("matchFontMaxRight", 22).put("bestOf", "3"))
        assertFalse(t.behind)
        assertFalse(t.countdownOnTimeout)
        assertEquals(22, t.fontMax("right"))
        assertEquals(3, t.bestOf)
    }
}
