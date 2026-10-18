package ch.kscw.pointhub

import ch.kscw.pointhub.game.GameHost
import ch.kscw.pointhub.net.HttpProbe
import java.net.HttpURLConnection
import java.net.URL

/** The tablet's side of the native Game tab: its prefs, and the board network it found and bound. */
class AndroidGameHost(private val app: PointHubApp) : GameHost {
    override var scorerPin: String
        get() = app.prefs.scorerPin
        set(v) { app.prefs.scorerPin = v }

    override var endAskedSig: String?
        get() = app.prefs.endAskedSig
        set(v) { app.prefs.endAskedSig = v }

    override fun boardOrigin(): String? = app.boardNetwork.currentOrigin

    override fun open(url: URL): HttpURLConnection = HttpProbe.open(url, app.boardNetwork.currentNetwork)
}
