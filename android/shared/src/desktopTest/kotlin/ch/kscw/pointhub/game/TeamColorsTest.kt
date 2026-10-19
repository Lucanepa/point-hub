package ch.kscw.pointhub.game

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject

/** Expected values come from web/index.html's own panelFor / teamText, run in node. */
class TeamColorsTest {
    private fun panel(hex: String) = TeamColors.panelFor(hex)!!.let { TeamColors.hex(it.bg) to TeamColors.hex(it.ink) }

    @Test fun panelMatchesTheConsole() {
        assertEquals("#b33333" to "#ffffff", panel("#ef4444"))
        assertEquals("#0a34d6" to "#ffffff", panel("#0a34d6"))
        assertEquals("#ffffff" to "#111318", panel("#ffffff"))
        assertEquals("#eab308" to "#111318", panel("#eab308"))
        assertEquals("#111827" to "#ffffff", panel("#111827"))
        assertEquals("#136c34" to "#ffffff", panel("#22c55e"))
        assertEquals("#be2916" to "#ffffff", panel("#e0301a"))
        assertEquals("#2159d4" to "#ffffff", panel("#2563eb"))
    }

    @Test fun teamTextOnTheDarkCard() {
        val card = TeamColors.parse("#1b212b")!!
        fun dark(hex: String) = TeamColors.hex(TeamColors.teamText(hex, card, dark = true)!!)
        assertEquals("#f04d4d", dark("#ef4444"))
        assertEquals("#6c85e6", dark("#0a34d6"))
        assertEquals("#888c93", dark("#111827"))
        assertEquals("#22c55e", dark("#22c55e"))
        // Light and e-ink use the colour as it is.
        assertEquals("#0a34d6", TeamColors.hex(TeamColors.teamText("#0a34d6", card, dark = false)!!))
    }

    @Test fun onlyRrggbbIsAColour() {
        assertNull(TeamColors.parse("red"))
        assertNull(TeamColors.parse("#fff"))
        assertNull(TeamColors.parse("#12345g"))
        assertNull(TeamColors.parse("red\"><img src=x>"))
        assertNull(TeamColors.panelFor(null))
        assertEquals(0x0a34d6, TeamColors.parse("#0A34D6"))
        assertEquals(0x0a34d6, TeamColors.parse("0a34d6"))
    }

    @Test fun einkInksTheDarkerTeam() {
        fun sides(l: String, r: String) = LiveState(JSONObject().put("team_a_color", l).put("team_b_color", r)).sides()
        assertTrue(TeamColors.inkCard("left", sides("#111827", "#ffffff")))
        assertFalse(TeamColors.inkCard("right", sides("#111827", "#ffffff")))
        assertTrue(TeamColors.inkCard("right", sides("#ffffff", "#111827")))
        // Equal colours: the panel's left half inks.
        assertTrue(TeamColors.inkCard("left", sides("#ef4444", "#ef4444")))
        assertFalse(TeamColors.inkCard("right", sides("#ef4444", "#ef4444")))
    }
}
