package ch.kscw.pointhub.net

import ch.kscw.pointhub.web.OriginPolicy

/** PURE. The origins to try, in priority order, and how long each one gets. */
object BoardEndpoints {
    /** Override first (if valid), then https, then the AP IP, then the cable IP; no duplicates. */
    fun candidates(override: String?): List<String> =
        (listOfNotNull(OriginPolicy.normalizeOverride(override)) + OriginPolicy.BUILT_IN).distinct()

    /**
     * What may be tried on the tablet's ordinary (default) network, when no board LAN was found:
     * only https origins. The plain-http board IPs are meaningful only on the board's own Wi-Fi or
     * cable; on a hall or guest network anything could answer at 172.24.1.1 and would be handed the
     * JS bridge over cleartext.
     */
    fun defaultNetworkCandidates(override: String?): List<String> =
        candidates(override).filter { it.startsWith("https://") }

    /** Connect / read timeouts and the overall budget for probing [origin]. */
    fun timeoutsFor(origin: String): Timeouts =
        if (origin.startsWith("https://")) Timeouts(connectMs = 2000, readMs = 2000, totalMs = 2500)
        else Timeouts(connectMs = 1500, readMs = 2000, totalMs = 3500)

    data class Timeouts(val connectMs: Int, val readMs: Int, val totalMs: Long)

    /** The origin used to recognise the board LAN on a given transport. */
    fun lanProbeOrigin(ethernet: Boolean): String =
        if (ethernet) OriginPolicy.CABLE_ORIGIN else OriginPolicy.AP_ORIGIN
}
