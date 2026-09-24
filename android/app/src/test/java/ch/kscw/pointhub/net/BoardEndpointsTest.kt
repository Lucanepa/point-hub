package ch.kscw.pointhub.net

import ch.kscw.pointhub.web.OriginPolicy
import org.junit.Assert.assertEquals
import org.junit.Test

class BoardEndpointsTest {
    private val defaults = listOf(
        "https://ledbox-c0270.noodlefish-pence.ts.net:8891",
        "http://172.24.1.1:8890",
        "http://192.168.5.1:8890",
    )

    @Test fun defaultOrder() = assertEquals(defaults, BoardEndpoints.candidates(null))

    @Test fun overrideFirst() =
        assertEquals(listOf("https://board.example:8443") + defaults, BoardEndpoints.candidates("https://board.example:8443"))

    @Test fun duplicatesRemovedAndNormalised() {
        assertEquals(
            listOf("http://172.24.1.1:8890", defaults[0], defaults[2]),
            BoardEndpoints.candidates("HTTP://172.24.1.1:8890/"),
        )
    }

    @Test fun invalidOverrideIgnored() {
        assertEquals(defaults, BoardEndpoints.candidates("http://evil.example"))
        assertEquals(defaults, BoardEndpoints.candidates("   "))
    }

    @Test fun lanProbeTargets() {
        assertEquals(OriginPolicy.AP_ORIGIN, BoardEndpoints.lanProbeOrigin(ethernet = false))
        assertEquals(OriginPolicy.CABLE_ORIGIN, BoardEndpoints.lanProbeOrigin(ethernet = true))
    }

    @Test fun httpsHasTighterBudget() {
        assertEquals(2500L, BoardEndpoints.timeoutsFor(defaults[0]).totalMs)
        assertEquals(1500, BoardEndpoints.timeoutsFor(defaults[1]).connectMs)
    }

    @Test fun defaultNetworkIsHttpsOnly() {
        assertEquals(listOf(defaults[0]), BoardEndpoints.defaultNetworkCandidates(null))
        // An http override (only ever a board IP) is not tried off the board LAN either.
        assertEquals(listOf(defaults[0]), BoardEndpoints.defaultNetworkCandidates("http://172.24.1.1:8890"))
        assertEquals(
            listOf("https://board.example:8443", defaults[0]),
            BoardEndpoints.defaultNetworkCandidates("https://board.example:8443"),
        )
    }
}
