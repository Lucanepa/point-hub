package ch.kscw.pointhub.desktop

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import ch.kscw.pointhub.game.GameController
import ch.kscw.pointhub.game.ui.Tab
import ch.kscw.pointhub.web.OriginPolicy
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.awt.FileDialog
import java.awt.Frame
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date

/**
 * The desktop app's state: finding the board, the console page, which tab is in front, and the
 * native Game tab (the same GameController as the tablet's). The rules of the tablet's MainActivity,
 * minus the kiosk: the native shell comes up only for a console that asks for it (BRIDGE.md), a
 * console that never asks is shown whole.
 */
class DesktopApp(val prefs: DesktopPrefs) : ConsoleHost {
    private val scope = MainScope()

    /** The board we talk to; null while searching. */
    var origin by mutableStateOf<String?>(null); private set
    var probes by mutableStateOf<List<Discovery.Probe>>(emptyList()); private set
    var searching by mutableStateOf(false); private set
    /** The console page asked for the native Game tab (and was told yes). */
    var embedded by mutableStateOf(false); private set
    var tab by mutableStateOf(Tab.GAME); private set
    var consoleTheme by mutableStateOf(prefs.theme); private set
    /** The console's page has the keyboard (a click in it); a click anywhere else takes it back. */
    var consoleFocused by mutableStateOf(false)
    var settingsOpen by mutableStateOf(false)

    val host = DesktopHost(prefs) { origin }
    val game = GameController(host)
    val console = Console(this)

    private var searchJob: Job? = null
    private var askedThisLoad = false

    init {
        game.onShowTab = { name, anchor -> showTabNow(name, anchor) }
        // The native pad's PIN is the page's PIN too: it reads it on every write.
        scope.launch { snapshotFlow { game.scorerPin }.collect { console.pushPin(it) } }
        // A page that loaded and never asked is an older console: show it whole.
        scope.launch {
            snapshotFlow { console.loading }.collect { loading ->
                if (loading) { askedThisLoad = false; return@collect }
                delay(800)
                if (!askedThisLoad && console.loadError == null && console.frame != null) leaveNative()
            }
        }
        find()
        watch()
    }

    // ------------------------------------------------------------------ the board

    /** Ask every address until one answers; then load the console from it. */
    fun find() {
        searchJob?.cancel()
        searchJob = scope.launch {
            searching = true
            while (isActive) {
                val (o, p) = Discovery.find(prefs.overrideOrigin)
                probes = p
                if (o != null) { connect(o); break }
                delay(3_000)
            }
            searching = false
        }
    }

    private fun connect(o: String) {
        if (o == origin && console.loadError == null) return
        origin = o
        prefs.lastOrigin = o
        game.origin = o
        console.load(o)
    }

    /**
     * The board went quiet (the Game tab cannot reach it, or the page failed): look again. The same
     * board answering means a reload; another address (the cable instead of Wi-Fi) means moving there.
     */
    private fun watch() = scope.launch {
        var quietSince = 0L
        while (isActive) {
            delay(5_000)
            val bad = origin != null && ((embedded && !game.reachable) || console.loadError != null)
            if (!bad) { quietSince = 0L; continue }
            if (quietSince == 0L) quietSince = System.currentTimeMillis()
            if (System.currentTimeMillis() - quietSince < 8_000 || searching) continue
            val (o, p) = Discovery.find(prefs.overrideOrigin)
            probes = p
            when {
                o == null -> Unit
                o != origin -> { quietSince = 0L; connect(o) }
                console.loadError != null -> { quietSince = 0L; console.reload() }
            }
        }
    }

    /** Settings: a board address, or none (find it). */
    fun setOverride(raw: String?): Boolean {
        val v = raw?.trim().orEmpty()
        if (v.isEmpty()) prefs.overrideOrigin = null
        else prefs.overrideOrigin = OriginPolicy.normalizeOverride(v) ?: return false
        origin = null
        find()
        return true
    }

    fun setNativeGame(on: Boolean) {
        prefs.nativeGame = on
        console.reload()
    }

    // ------------------------------------------------------------------ tabs

    private fun enterNative() {
        if (embedded) return
        embedded = true
        game.start()
        if (tab != Tab.GAME) showConsoleTab(tab, null)
    }

    private fun leaveNative() {
        if (!embedded) return
        embedded = false
        game.stop()
    }

    fun selectTab(t: Tab, anchor: String? = null) {
        tab = t
        if (t == Tab.GAME) {
            consoleFocused = false
            console.js("window.pointhubEmbed&&window.pointhubEmbed.hide&&window.pointhubEmbed.hide()")
            game.enterGameTab()
        } else showConsoleTab(t, anchor)
    }

    private fun showConsoleTab(t: Tab, anchor: String?) {
        val a = if (anchor == "uplink") ",'uplink'" else ""
        console.js("window.pointhubEmbed&&window.pointhubEmbed.show('${t.key}'$a)")
    }

    private fun showTabNow(name: String, anchor: String?) {
        if (name == "serve-order") {
            selectTab(Tab.GAME)
            game.serveOrderFromConsole()
            return
        }
        Tab.of(name)?.let { selectTab(it, anchor) }
    }

    /** No native dialog over the page: keys may go to it. */
    fun keysToConsole(): Boolean = !settingsOpen && game.pinPad == null && game.confirm == null && game.edit == null &&
        game.colorAsk == null && game.sportPicker == null && game.gamePicker == null && game.matchEnd == null &&
        game.liveLog == null && game.serveOrder == null

    // ------------------------------------------------------------------ ConsoleHost

    override val nativeGameEnabled: Boolean get() = prefs.nativeGame
    override fun scorerPin(): String = prefs.scorerPin
    override fun onNativeGameAsked() { askedThisLoad = true; enterNative() }
    override fun showTab(name: String) = showTabNow(name, null)
    override fun setScorerPin(pin: String) = game.pinFromConsole(pin)
    override fun pinRejected() = game.onPinRejected()
    override fun settingsChanged() = game.settingsChanged()
    override fun setTheme(theme: String) { consoleTheme = theme; prefs.theme = theme }
    override fun reloadConsole() = console.reload()
    override fun openSettings() { settingsOpen = true }

    /** The console's "Export backups": a zip wherever the user saves it. */
    override fun exportBackups() {
        val name = "pointhub-backups-" + SimpleDateFormat("yyyyMMdd-HHmm").format(Date()) + ".zip"
        val d = FileDialog(null as Frame?, "Save the backups", FileDialog.SAVE).apply { file = name; isVisible = true }
        val dir = d.directory
        val file = d.file
        if (dir == null || file == null) {
            console.sendEvent(JSONObject().put("type", "export").put("ok", false).put("reason", "cancelled"))
            return
        }
        val event = try {
            val extras = LinkedHashMap<String, ByteArray>()
            console.schedule.bytesOrNull()?.let { extras["schedule.json"] = it }
            extras["manifest.json"] = JSONObject().put("app", "pointhub-desktop").put("version", APP_VERSION)
                .put("backups", org.json.JSONArray(console.backups.listJson())).toString(2).toByteArray()
            val n = File(dir, file).outputStream().use { console.backups.writeZip(it, extras) }
            JSONObject().put("type", "export").put("ok", true).put("files", n)
        } catch (_: Exception) {
            JSONObject().put("type", "export").put("ok", false).put("reason", "io")
        }
        console.sendEvent(event)
    }

    fun dispose() {
        game.stop()
        console.dispose()
        scope.cancel()
    }
}
