package ch.kscw.pointhub.desktop

import ch.kscw.pointhub.game.GameHost
import java.net.HttpURLConnection
import java.net.URL

/** The desktop's side of the native Game tab: its settings file, and the board discovery found. */
class DesktopHost(private val prefs: DesktopPrefs, private val origin: () -> String?) : GameHost {
    override var scorerPin: String
        get() = prefs.scorerPin
        set(v) { prefs.scorerPin = v }

    override var endAskedSig: String?
        get() = prefs.endAskedSig
        set(v) { prefs.endAskedSig = v }

    override fun boardOrigin(): String? = origin()

    override fun open(url: URL): HttpURLConnection = url.openConnection() as HttpURLConnection
}
