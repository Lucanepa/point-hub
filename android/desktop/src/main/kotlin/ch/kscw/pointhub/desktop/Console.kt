package ch.kscw.pointhub.desktop

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import ch.kscw.pointhub.web.OriginPolicy
import com.jetbrains.cef.JCefAppConfig
import org.cef.CefApp
import org.cef.CefClient
import org.cef.CefSettings
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.browser.CefMessageRouter
import org.cef.browser.CefRendering
import org.cef.callback.CefCallback
import org.cef.callback.CefQueryCallback
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefMessageRouterHandlerAdapter
import org.cef.handler.CefRenderHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.handler.CefResourceHandler
import org.cef.handler.CefResourceRequestHandler
import org.cef.handler.CefResourceRequestHandlerAdapter
import org.cef.handler.CefScreenInfo
import org.cef.misc.BoolRef
import org.cef.misc.IntRef
import org.cef.misc.StringRef
import org.cef.network.CefRequest
import org.cef.network.CefResponse
import org.jetbrains.skia.ColorAlphaType
import org.jetbrains.skia.ColorType
import org.jetbrains.skia.Image
import org.jetbrains.skia.ImageInfo
import org.json.JSONArray
import org.json.JSONObject
import java.awt.Point
import java.awt.Rectangle
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.ByteBuffer
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Chromium (JCEF, from JetBrains Runtime) for the console's own tabs, in off-screen mode: every
 * frame arrives as pixels (onPaint) and is drawn by Compose (ConsolePane), and input goes back as
 * AWT events. No native child window, so the native header and dialogs always draw on top of it.
 */
object Cef {
    lateinit var app: CefApp
        private set

    /** Once, before any window: Chromium's processes, its cache in Paths.cefCache. */
    fun start() {
        val config = JCefAppConfig.getInstance()
        val args = ArrayList(config.appArgsAsList)
        // Software compositing: a settings page needs no GPU, and it keeps working in a VM or over
        // remote desktop, where GPU paths are where Chromium fails.
        args += "--disable-gpu"
        System.getenv("POINTHUB_CEF_ARGS")?.split(' ')?.filter { it.isNotBlank() }?.let { args += it }
        val settings = config.cefSettings
        settings.windowless_rendering_enabled = true
        // No Chromium sandbox: its setuid helper is not installed setuid by a package, unprivileged
        // user namespaces are off on Ubuntu 24.04 and absent in Flatpak, and either failure is a
        // crash at start. What makes that safe here is Console's lockdown: the page can only ever
        // be the scoreboard's own (every other navigation, request and popup is refused).
        settings.no_sandbox = true
        settings.cache_path = Paths.cefCache.absolutePath
        settings.log_severity = CefSettings.LogSeverity.LOGSEVERITY_ERROR
        settings.locale = "en-US"
        val arr = args.toTypedArray()
        CefApp.startup(arr)
        app = CefApp.getInstance(arr, settings)
    }

    fun shutdown() {
        try { if (::app.isInitialized) app.dispose() } catch (_: Exception) {}
    }
}

/** What the console page asks of the app (BRIDGE.md). Called on the UI thread. */
interface ConsoleHost {
    val nativeGameEnabled: Boolean
    fun scorerPin(): String
    fun onNativeGameAsked()
    fun showTab(name: String)
    fun setScorerPin(pin: String)
    fun pinRejected()
    fun settingsChanged()
    fun setTheme(theme: String)
    fun reloadConsole()
    fun openSettings()
    fun exportBackups()
}

class Console(private val host: ConsoleHost) {
    /** The page's pixels and the open <select> popup's, for ConsolePane. */
    var frame by mutableStateOf<ImageBitmap?>(null); private set
    var popup by mutableStateOf<Pair<Rectangle, ImageBitmap>?>(null); private set
    var popupRect: Rectangle? = null
    var cursorType by mutableStateOf(java.awt.Cursor.DEFAULT_CURSOR); private set
    var loading by mutableStateOf(true); private set
    /** The main frame failed to load (the board went away): the reason, or null. */
    var loadError by mutableStateOf<String?>(null); private set

    @Volatile var origin: String? = null; private set
    @Volatile var viewWidth = 1280; private set
    @Volatile var viewHeight = 720; private set
    @Volatile var scale = 1.0; private set

    val backups = ch.kscw.pointhub.store.BackupStore(java.io.File(Paths.data, "backups"))
    val schedule = ch.kscw.pointhub.store.ScheduleStore(java.io.File(Paths.data, "schedule.json"))

    private val client: CefClient = Cef.app.createClient()
    /** Only ever a source for the AWT events handed to Chromium; never shown. */
    val awtSource = JPanel()
    private var browser: CefBrowser? = null

    private val render = object : CefRenderHandlerAdapter() {
        override fun getViewRect(b: CefBrowser): Rectangle = Rectangle(0, 0, viewWidth, viewHeight)
        override fun getScreenInfo(b: CefBrowser, info: CefScreenInfo): Boolean {
            info.Set(scale, 32, 8, false, Rectangle(0, 0, viewWidth, viewHeight), Rectangle(0, 0, viewWidth, viewHeight))
            return true
        }
        override fun getScreenPoint(b: CefBrowser, p: Point): Point = p
        override fun getDeviceScaleFactor(b: CefBrowser): Double = scale
        override fun onPopupShow(b: CefBrowser, show: Boolean) {
            if (!show) { popupRect = null; SwingUtilities.invokeLater { popup = null } }
        }
        override fun onPopupSize(b: CefBrowser, size: Rectangle) { popupRect = Rectangle(size) }
        override fun onPaint(b: CefBrowser, isPopup: Boolean, dirty: Array<out Rectangle>?, buffer: ByteBuffer, width: Int, height: Int) {
            // The buffer only lives for this call: copy it out now.
            val bytes = ByteArray(width * height * 4)
            buffer.position(0)
            buffer.get(bytes)
            val img = Image.makeRaster(ImageInfo(width, height, ColorType.BGRA_8888, ColorAlphaType.PREMUL), bytes, width * 4)
                .toComposeImageBitmap()
            val pr = popupRect
            SwingUtilities.invokeLater {
                if (isPopup) { if (pr != null) popup = pr to img } else frame = img
            }
        }
        override fun onCursorChange(b: CefBrowser, cursorType: Int): Boolean {
            SwingUtilities.invokeLater { this@Console.cursorType = cursorType }
            return true
        }
    }

    init {
        val router = CefMessageRouter.create(CefMessageRouter.CefMessageRouterConfig("cefQuery", "cefQueryCancel"))
        router.addHandler(object : CefMessageRouterHandlerAdapter() {
            override fun onQuery(b: CefBrowser, f: CefFrame, id: Long, request: String, persistent: Boolean, cb: CefQueryCallback): Boolean {
                if (!f.isMain || !isBoard(f.url)) { cb.failure(403, "not a board page"); return true }
                val q = try { JSONObject(request) } catch (_: Exception) { cb.failure(400, "bad request"); return true }
                val a = q.optJSONArray("a") ?: JSONArray()
                cb.success(onBridge(q.optString("m"), a))
                return true
            }
        }, true)
        client.addMessageRouter(router)
        client.addRequestHandler(object : CefRequestHandlerAdapter() {
            // Only the scoreboard's own pages, in any frame: a link to anywhere else does nothing.
            override fun onBeforeBrowse(b: CefBrowser, f: CefFrame?, request: CefRequest, userGesture: Boolean, isRedirect: Boolean): Boolean =
                !permitted(request.url)

            override fun getResourceRequestHandler(
                b: CefBrowser, f: CefFrame?, request: CefRequest, isNavigation: Boolean, isDownload: Boolean,
                initiator: String?, disableDefault: BoolRef,
            ): CefResourceRequestHandler? {
                // Anything not from the board (a script, an image, a fetch elsewhere) is never loaded.
                if (!permitted(request.url)) return BLOCK
                // The console page itself, fetched here and handed over with the bridge in it.
                if (!isNavigation || f == null || !f.isMain || request.method != "GET") return null
                if (!isConsoleDocument(request.url)) return null
                return object : CefResourceRequestHandlerAdapter() {
                    override fun getResourceHandler(b: CefBrowser, f: CefFrame, r: CefRequest): CefResourceHandler = ConsoleDocument(r.url)
                }
            }
        })
        // No second windows (target=_blank, window.open): the console never needs one.
        client.addLifeSpanHandler(object : org.cef.handler.CefLifeSpanHandlerAdapter() {
            override fun onBeforePopup(b: CefBrowser, f: CefFrame?, url: String?, frameName: String?): Boolean = true
        })
        client.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadingStateChange(b: CefBrowser, isLoading: Boolean, canGoBack: Boolean, canGoForward: Boolean) {
                SwingUtilities.invokeLater { loading = isLoading }
            }
            override fun onLoadError(b: CefBrowser, f: CefFrame, code: CefLoadHandler.ErrorCode, text: String?, url: String?) {
                if (!f.isMain || code == CefLoadHandler.ErrorCode.ERR_ABORTED) return
                SwingUtilities.invokeLater { loadError = text ?: code.name }
            }
            override fun onLoadEnd(b: CefBrowser, f: CefFrame, status: Int) {
                if (f.isMain) SwingUtilities.invokeLater { if (status in 200..399) loadError = null }
            }
        })
    }

    /** The board's own URLs, and the inert local ones a page may use (about:blank, data:, its blobs). */
    private fun permitted(url: String?): Boolean {
        if (url == null) return false
        val u = url.trim().lowercase()
        if (u == "about:blank" || u.startsWith("data:")) return true
        if (u.startsWith("blob:")) return isBoard(url.trim().substring(5))
        return isBoard(url)
    }

    private val BLOCK = object : CefResourceRequestHandlerAdapter() {
        override fun onBeforeResourceLoad(b: CefBrowser, f: CefFrame?, r: CefRequest): Boolean = true
    }

    private fun isBoard(url: String?): Boolean {
        val o = OriginPolicy.originOf(url) ?: return false
        return o == origin
    }

    private fun isConsoleDocument(url: String?): Boolean {
        if (!isBoard(url)) return false
        val path = try { URI(url).rawPath ?: "" } catch (_: Exception) { return false }
        return path == "" || path == "/" || path == "/index.html"
    }

    /** Loads the console from [origin] (in app mode), creating the browser the first time. */
    fun load(origin: String) {
        this.origin = origin
        loadError = null
        val url = "$origin/?app=1"
        val b = browser
        if (b == null) {
            val nb = client.createBrowser(url, CefRendering.CefRenderingWithHandler(render, awtSource), false)
            nb.createImmediately()
            browser = nb
        } else b.loadURL(url)
    }

    fun reload() { origin?.let { load(it) } }

    /** Smoke test (POINTHUB_SMOKE): load a page with no board, to see Chromium paint a frame. */
    fun loadRaw(url: String) {
        val b = browser
        if (b == null) {
            val nb = client.createBrowser(url, CefRendering.CefRenderingWithHandler(render, awtSource), false)
            nb.createImmediately()
            browser = nb
        } else b.loadURL(url)
    }

    fun resize(widthDip: Int, heightDip: Int, scale: Double) {
        if (widthDip <= 0 || heightDip <= 0) return
        val changed = scale != this.scale
        viewWidth = widthDip
        viewHeight = heightDip
        this.scale = scale
        browser?.let {
            if (changed) it.notifyScreenInfoChanged()
            it.wasResized(widthDip, heightDip)
        }
    }

    fun js(code: String) {
        val b = browser ?: return
        if (!isBoard(b.url)) return
        b.executeJavaScript(code, b.url, 0)
    }

    fun sendMouse(e: java.awt.event.MouseEvent) { browser?.sendMouseEvent(e) }
    fun sendWheel(e: java.awt.event.MouseWheelEvent) { browser?.sendMouseWheelEvent(e) }
    fun sendKey(e: java.awt.event.KeyEvent) { browser?.sendKeyEvent(e) }
    fun focus(on: Boolean) { browser?.setFocus(on) }

    fun dispose() {
        try { browser?.close(true) } catch (_: Exception) {}
        try { client.dispose() } catch (_: Exception) {}
    }

    /** The app's PIN changed (an unlock or lock on the native pad): the page's copy follows. */
    fun pushPin(pin: String) = js("window.__pointhubPin&&window.__pointhubPin(${JSONObject.quote(pin)})")

    fun sendEvent(detail: JSONObject) = js("window.dispatchEvent(new CustomEvent('pointhubapp',{detail:$detail}))")

    // ------------------------------------------------------------------ the bridge

    /** One call from the page (on Chromium's thread); returns what the page's callback gets. */
    private fun onBridge(m: String, a: JSONArray): String {
        fun s(i: Int) = a.opt(i)?.takeIf { it != JSONObject.NULL }?.toString()
        fun ui(block: () -> Unit) = SwingUtilities.invokeLater(block)
        return when (m) {
            "nativeGame" -> { ui { host.onNativeGameAsked() }; "" }
            "showTab" -> { s(0)?.let { n -> ui { host.showTab(n) } }; "" }
            "setScorerPin" -> { s(0)?.takeIf { it.length <= 8 }?.let { p -> ui { host.setScorerPin(p) } }; "" }
            "pinRejected" -> { ui { host.pinRejected() }; "" }
            "settingsChanged" -> { ui { host.settingsChanged() }; "" }
            "setTheme" -> { val t = s(0); ui { host.setTheme(if (t == "dark" || t == "eink") t else "light") }; "" }
            "reloadConsole" -> { ui { host.reloadConsole() }; "" }
            "openSettings" -> { ui { host.openSettings() }; "" }
            "exportBackups" -> { ui { host.exportBackups() }; "" }
            "saveBackup" -> {
                val ok = try { s(1)?.let { backups.save(s(0), it) } != null } catch (_: Exception) { false }
                if (ok) js("window.__pointhubBackups&&window.__pointhubBackups(${JSONObject.quote(backups.listJson())})")
                ok.toString()
            }
            "saveSchedule" -> {
                val ok = try { s(0)?.let { schedule.save(it) } == true } catch (_: Exception) { false }
                ok.toString()
            }
            else -> ""
        }
    }

    /** What window.PointHubApp starts with: the values the page reads synchronously. */
    private fun bridgeState(): JSONObject = JSONObject()
        .put("native", host.nativeGameEnabled)
        .put("pin", host.scorerPin())
        .put("info", JSONObject()
            .put("app", "pointhub-desktop")
            .put("versionCode", 0)
            .put("versionName", APP_VERSION)
            .put("device", System.getProperty("os.name") + " " + System.getProperty("os.arch"))
            .put("android", JSONObject.NULL)
            .put("origin", origin ?: JSONObject.NULL)
            .put("network", "default")
            .put("deviceOwner", false)
            .put("lockTask", "none")
            .toString())
        .put("backups", try { backups.listJson() } catch (_: Exception) { "[]" })
        .put("schedule", try { schedule.load() } catch (_: Exception) { null } ?: JSONObject.NULL)

    /**
     * `window.PointHubApp` for the desktop. The console calls it synchronously (BRIDGE.md), and
     * Chromium only offers asynchronous calls into the app, so the page gets an object that answers
     * from values handed to it with the page (and updated by the app when they change), and sends
     * everything else on through cefQuery.
     */
    private fun bridgeScript(): String = """
<script>
(function () {
  "use strict";
  var st = ${bridgeState()};
  function send(m, a) {
    try { window.cefQuery({ request: JSON.stringify({ m: m, a: a || [] }), persistent: false, onSuccess: function () {}, onFailure: function () {} }); } catch (e) {}
  }
  window.__pointhubPin = function (p) { st.pin = String(p || ""); };
  window.__pointhubBackups = function (j) { st.backups = String(j || "[]"); };
  window.PointHubApp = Object.freeze({
    getInfo: function () { return st.info; },
    keepAwake: function () {},
    saveBackup: function (name, json) { if (typeof json !== "string" || json.length > 5242880) return false; send("saveBackup", [String(name || ""), json]); return true; },
    listBackups: function () { return st.backups; },
    exportBackups: function () { send("exportBackups"); return true; },
    saveSchedule: function (json) { if (typeof json !== "string" || json.length > 2097152) return false; st.schedule = json; send("saveSchedule", [json]); return true; },
    loadSchedule: function () { return st.schedule; },
    reloadConsole: function () { send("reloadConsole"); },
    openSettings: function () { send("openSettings"); },
    nativeGame: function () { if (st.native) send("nativeGame"); return st.native === true; },
    showTab: function (n) { send("showTab", [String(n)]); },
    scorerPin: function () { return st.pin; },
    setScorerPin: function (p) { p = String(p == null ? "" : p); if (p.length > 8) return; st.pin = p; send("setScorerPin", [p]); },
    pinRejected: function () { st.pin = ""; send("pinRejected"); },
    settingsChanged: function () { send("settingsChanged"); },
    setTheme: function (t) { send("setTheme", [String(t)]); }
  });
})();
</script>
""".trimIndent()

    /** The console's HTML, fetched here, with the bridge put in before any of its own scripts. */
    private inner class ConsoleDocument(private val url: String) : CefResourceHandler {
        private var status = 502
        private var mime = "text/html"
        private var body = ByteArray(0)
        private var offset = 0
        @Volatile private var cancelled = false

        override fun processRequest(request: CefRequest, callback: CefCallback): Boolean {
            Thread({
                try {
                    val c = URL(url).openConnection() as HttpURLConnection
                    c.instanceFollowRedirects = false
                    c.connectTimeout = 4000
                    c.readTimeout = 10000
                    c.setRequestProperty("Accept", "text/html")
                    status = c.responseCode
                    mime = (c.contentType ?: "text/html").substringBefore(';').trim()
                    val raw = (if (status >= 400) c.errorStream else c.inputStream)?.use { it.readBytes() } ?: ByteArray(0)
                    body = if (status == 200 && mime == "text/html") inject(raw.toString(Charsets.UTF_8)).toByteArray(Charsets.UTF_8) else raw
                    c.disconnect()
                } catch (e: Exception) {
                    status = 502
                    body = ByteArray(0)
                }
                if (!cancelled) callback.Continue()
            }, "console-document").apply { isDaemon = true }.start()
            return true
        }

        private fun inject(html: String): String {
            val script = bridgeScript()
            // First thing in the document after <meta charset>, so the console's own scripts (the
            // theme boot script included) already find it.
            val m = Regex("<meta charset=[^>]*>", RegexOption.IGNORE_CASE).find(html)
            return if (m != null) html.substring(0, m.range.last + 1) + "\n" + script + html.substring(m.range.last + 1)
            else script + html
        }

        override fun getResponseHeaders(response: CefResponse, length: IntRef, redirect: StringRef) {
            response.status = status
            response.mimeType = mime
            response.setHeaderByName("Cache-Control", "no-store", true)
            response.setHeaderByName("Content-Type", "$mime; charset=utf-8", true)
            length.set(body.size)
        }

        override fun readResponse(out: ByteArray, bytesToRead: Int, bytesRead: IntRef, callback: CefCallback): Boolean {
            if (offset >= body.size) { bytesRead.set(0); return false }
            val n = minOf(bytesToRead, body.size - offset)
            System.arraycopy(body, offset, out, 0, n)
            offset += n
            bytesRead.set(n)
            return true
        }

        override fun cancel() { cancelled = true }
    }
}
