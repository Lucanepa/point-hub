package ch.kscw.pointhub

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.isVisible
import ch.kscw.pointhub.kiosk.CornerTapDetector
import ch.kscw.pointhub.kiosk.Kiosk
import ch.kscw.pointhub.net.FailReason
import ch.kscw.pointhub.net.Hint
import ch.kscw.pointhub.net.NetState
import ch.kscw.pointhub.net.hasWifiRequestPermission
import ch.kscw.pointhub.net.wifiRequestPermission
import ch.kscw.pointhub.store.BackupNames
import ch.kscw.pointhub.store.BackupStore
import ch.kscw.pointhub.store.MatchSummary
import ch.kscw.pointhub.store.ScheduleStore
import ch.kscw.pointhub.ui.Ui
import ch.kscw.pointhub.update.UpdateState
import ch.kscw.pointhub.web.BridgeHost
import ch.kscw.pointhub.web.ConsoleHost
import ch.kscw.pointhub.web.ConsoleWebView
import ch.kscw.pointhub.web.OriginPolicy
import ch.kscw.pointhub.web.PointHubBridge
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * The kiosk host: one fullscreen WebView showing the board's console, a native offline overlay
 * that covers it whenever no console page is alive (so no browser error page ever shows), the
 * update banner, and the hidden 5-tap admin gesture.
 *
 * A LIVE console page is never covered or reloaded because the board link dropped: the console
 * keeps recording scores without the board. Losing the link shows a small pass-through note and
 * sends the page a 'network lost' event; the link coming back on the same origin sends
 * 'restored' and nothing else.
 */
class MainActivity : ComponentActivity(), ConsoleHost, BridgeHost {
    companion object {
        private const val TAG = "MainActivity"
        private const val RETRY_MS = 3_000L
        private const val UPDATE_TICK_MS = 60_000L
        const val RESULT_EXIT_APP = 100

        /** The HTTP cache is dropped once per process start (DOM storage and cookies survive). */
        private var cacheClearedThisProcess = false
        /** keepAwake(false) holds until keepAwake(true) or the next app start. */
        @Volatile private var keepAwake = true
    }

    private lateinit var app: PointHubApp
    private val main = Handler(Looper.getMainLooper())
    private val scope = MainScope()

    private lateinit var webHolder: FrameLayout
    private var webView: WebView? = null
    private lateinit var offline: View
    private lateinit var offlineBody: TextView
    private lateinit var offlineStatus: TextView
    private lateinit var offlineHint: TextView
    private lateinit var matchCard: View
    private lateinit var matchText: TextView
    private lateinit var banner: View
    private lateinit var bannerText: TextView
    private lateinit var bannerInstall: Button
    private lateinit var netPill: View

    private val committed = AtomicReference<String?>(null)
    @Volatile override var allowlist = OriginPolicy.Allowlist(null)
        private set
    override val debug: Boolean get() = BuildConfig.DEBUG

    /** A board page has committed and has not failed since. */
    private var pageAlive = false
    private var loadedOrigin: String? = null
    private var forceReload = false
    private var resumed = false
    private var wasLost = false
    private var announcedUpdateCode = -1
    private var adminOpen = false
    private val exporting = AtomicBoolean(false)
    private val corner = CornerTapDetector()
    private lateinit var bridge: PointHubBridge

    private lateinit var exportLauncher: ActivityResultLauncher<String>
    private lateinit var adminLauncher: ActivityResultLauncher<Intent>
    private lateinit var permissionLauncher: ActivityResultLauncher<String>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app = pointHub
        Kiosk.restoreAfterExit(this)
        if (!app.prefs.setupDone) {
            startActivity(Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_FIRST_RUN, true))
            finish()
            return
        }
        setContentView(R.layout.activity_main)
        webHolder = findViewById(R.id.webHolder)
        offline = findViewById(R.id.offline)
        offlineBody = findViewById(R.id.offlineBody)
        offlineStatus = findViewById(R.id.offlineStatus)
        offlineHint = findViewById(R.id.offlineHint)
        matchCard = findViewById(R.id.matchCard)
        matchText = findViewById(R.id.matchText)
        banner = findViewById(R.id.updateBanner)
        bannerText = findViewById(R.id.updateText)
        bannerInstall = findViewById(R.id.updateInstall)
        netPill = findViewById(R.id.netPill)

        Ui.immersive(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        allowlist = OriginPolicy.Allowlist(app.prefs.overrideOrigin)
        bridge = PointHubBridge(this)

        exportLauncher = registerForActivityResult(BackupExporter.CreateZip()) { uri -> onExportTarget(uri) }
        adminLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r -> onAdminClosed(r.resultCode) }
        permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startBoardWifiRequest()
        }

        createWebView()
        if (!cacheClearedThisProcess) {
            webView?.clearCache(true)
            cacheClearedThisProcess = true
        }

        // Back never leaves the app: it goes back in the console's history, or does nothing.
        onBackPressedDispatcher.addCallback(this) {
            val wv = webView
            if (wv != null && !offline.isVisible && wv.canGoBack() && allowlist.isAllowed(committed.get())) wv.goBack()
        }

        findViewById<Button>(R.id.offlineRetry).setOnClickListener {
            offlineStatus.text = "Retrying…"
            app.boardNetwork.rediscover()
        }
        findViewById<Button>(R.id.offlineWifi).setOnClickListener { connectBoardWifi() }
        // Only the explicit button opens the PIN prompt; the banner itself ignores touches.
        bannerInstall.setOnClickListener { onInstallTapped() }
        findViewById<Button>(R.id.updateDismiss).setOnClickListener {
            (app.updates.state.value as? UpdateState.Available)?.let { app.prefs.dismissedUpdateCode = it.version.versionCode }
            banner.visibility = View.GONE
        }

        showOffline(null)
        scope.launch { app.boardNetwork.state.collect { onNetState(it) } }
        scope.launch { app.boardNetwork.progress.collect { if (it.isNotEmpty() && offline.isVisible) offlineStatus.text = it } }
        scope.launch { app.updates.state.collect { onUpdateState(it) } }
        app.boardNetwork.start()
    }

    // ---------------------------------------------------------------- WebView lifecycle

    private fun createWebView() {
        val wv = WebView(this)
        wv.setBackgroundColor(0xFF000000.toInt())
        ConsoleWebView.configure(wv, this, ConsoleWebView.userAgent(this, AppInfo.versionName(this)))
        addBridge(wv)
        webHolder.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = wv
    }

    // The bridge object is exposed to every frame, so the WebViewClient blocks every non-board
    // origin from loading at all, and each bridge method re-checks the committed main-frame origin.
    @SuppressLint("JavascriptInterface", "AddJavascriptInterface")
    private fun addBridge(wv: WebView) = wv.addJavascriptInterface(bridge, PointHubBridge.NAME)

    private fun load(origin: String) {
        val wv = webView ?: return
        loadedOrigin = origin
        pageAlive = false
        wasLost = false
        netPill.visibility = View.GONE
        Log.i(TAG, "loading console from $origin")
        // ?app=1: the console's installed-app mode (no full-screen gate). The console removes it
        // from the address bar itself. See BRIDGE.md "App mode".
        wv.loadUrl("$origin/?app=1")
    }

    override fun onMainFrameUrl(url: String?) {
        val origin = OriginPolicy.originOf(url)
        committed.set(if (origin != null && allowlist.isAllowed(url)) origin else null)
    }

    override fun onMainFrameVisible(url: String?) {
        if (!allowlist.isAllowed(url)) return
        onMainFrameUrl(url)
        pageAlive = true
        hideOffline()
        if (app.boardNetwork.state.value is NetState.Found) netPill.visibility = View.GONE
    }

    override fun onMainFrameFailed(url: String?, reason: String) {
        // Only a failure of the board page we asked for counts (not about:blank, not a stale load).
        val origin = OriginPolicy.originOf(url)
        if (url != null && (origin == null || origin != loadedOrigin)) return
        Log.w(TAG, "main frame failed: $reason ($url)")
        committed.set(null)
        val wasAlive = pageAlive
        pageAlive = false
        webView?.let { it.stopLoading(); it.loadUrl("about:blank") }
        netPill.visibility = View.GONE
        showOffline(reason)
        if (reason.startsWith("certificate") || reason.startsWith("HTTP")) app.boardNetwork.demote(loadedOrigin)
        else app.boardNetwork.rediscover()
        if (wasAlive) Log.i(TAG, "console page lost")
    }

    override fun onRendererGone(view: WebView) {
        committed.set(null)
        pageAlive = false
        webHolder.removeView(view)
        view.destroy()
        webView = null
        createWebView()
        showOffline("console restarted")
        app.boardNetwork.rediscover()
    }

    // ---------------------------------------------------------------- Board network

    private fun onNetState(s: NetState) {
        when (s) {
            is NetState.Found -> {
                // Reload only when there is no live page, it was asked for, or the board is now
                // reachable under a different origin than the one the page talks to (e.g. Wi-Fi
                // dropped and the cable took over: the old origin is not reachable there).
                if (forceReload || !pageAlive || loadedOrigin == null || s.origin != loadedOrigin) {
                    forceReload = false
                    load(s.origin)
                } else if (wasLost) {
                    wasLost = false
                    netPill.visibility = View.GONE
                    main.removeCallbacks(retryLoop)
                    sendEvent(JSONObject().put("type", "network").put("state", "restored"))
                }
                maybeCheckUpdate()
            }
            is NetState.NotFound -> {
                if (offline.isVisible) renderFailures(s)
            }
            NetState.Lost -> {
                if (pageAlive && !offline.isVisible) {
                    // Keep the console usable: it records scores without the board.
                    if (!wasLost) sendEvent(JSONObject().put("type", "network").put("state", "lost"))
                    wasLost = true
                    netPill.visibility = View.VISIBLE
                    startRetryLoop()
                } else {
                    showOffline("Scoreboard connection lost")
                }
            }
            is NetState.Searching, NetState.Idle -> Unit
        }
    }

    private fun renderFailures(s: NetState.NotFound) {
        val parts = s.failures.map { (origin, f) ->
            val where = when (origin) {
                OriginPolicy.HTTPS_ORIGIN -> "https"
                OriginPolicy.AP_ORIGIN -> "172.24.1.1"
                OriginPolicy.CABLE_ORIGIN -> "cable"
                else -> origin
            }
            "$where: " + when (f.reason) {
                FailReason.DNS -> "name not found"
                FailReason.CONNECT -> "not reachable"
                FailReason.TIMEOUT -> "no answer"
                FailReason.TLS_DATE -> "certificate date (clock?)"
                FailReason.TLS_OTHER -> "certificate"
                FailReason.HTTP_STATUS -> f.detail ?: "bad answer"
                FailReason.NOT_JSON -> "not the scoreboard"
                FailReason.CLEARTEXT_BLOCKED -> "blocked"
                FailReason.NO_NETWORK -> "no network"
                FailReason.OTHER -> "error"
            }
        }
        offlineStatus.text = (if (s.lanFound) "Scoreboard network found. " else "Scoreboard network not found. ") + parts.joinToString(" · ")
        val hint = when (s.hint) {
            Hint.CLOCK -> "The tablet clock looks wrong. Check date and time in Settings."
            Hint.NO_WIFI_PERMISSION -> "Point Hub may not join Wi-Fi yet: tap \"Connect to scoreboard Wi-Fi\" and allow \"Nearby devices\"."
            Hint.WIFI_REQUEST_DECLINED -> "The scoreboard Wi-Fi was not joined: it was not found in time, or the request was not confirmed."
            Hint.NO_WIFI_CONFIGURED -> "No scoreboard Wi-Fi password saved. Set it in the admin menu."
            null -> null
        }
        offlineHint.text = hint
        offlineHint.visibility = if (hint == null) View.GONE else View.VISIBLE
    }

    /**
     * The offline screen's "Connect to scoreboard Wi-Fi". Android's "Connect to device" dialog
     * opens in another task, which lock task blocks, so while pinned this needs the admin PIN
     * (the tablet is unpinned while the dialog shows). Unpinned it runs straight away.
     */
    private fun connectBoardWifi() {
        if (Kiosk.isLockTaskActive(this)) Ui.askPin(this, "Connect to scoreboard Wi-Fi") { connectBoardWifiNow() }
        else connectBoardWifiNow()
    }

    private fun connectBoardWifiNow() {
        val perm = wifiRequestPermission()
        if (perm != null && !hasWifiRequestPermission(this)) {
            // The permission dialog opens in our own task: lock task stays on.
            Kiosk.launchInTask { permissionLauncher.launch(perm) }
        } else {
            startBoardWifiRequest()
        }
    }

    private fun startBoardWifiRequest() {
        Kiosk.suspendFor(this) { app.boardNetwork.requestBoardWifi() }
    }

    // ---------------------------------------------------------------- Offline overlay

    /** Every 3 s while the offline screen or the "connection lost" note is up. */
    private val retryLoop = object : Runnable {
        override fun run() {
            if (!offline.isVisible && !netPill.isVisible) return
            if (app.boardNetwork.state.value !is NetState.Found) app.boardNetwork.discover()
            main.postDelayed(this, RETRY_MS)
        }
    }

    private fun startRetryLoop() {
        main.removeCallbacks(retryLoop)
        main.postDelayed(retryLoop, RETRY_MS)
    }

    private fun showOffline(reason: String?) {
        offlineBody.text = getString(R.string.offline_body, app.prefs.ssid)
        offlineStatus.text = reason ?: "Trying https… / 172.24.1.1… / cable…"
        offlineHint.visibility = View.GONE
        if (!offline.isVisible) {
            offline.visibility = View.VISIBLE
            startRetryLoop()
        }
        thread(name = "last-match") {
            val summary = try { app.backups.newestSummary() } catch (_: Exception) { null }
            main.post { renderSummary(summary) }
        }
    }

    private fun hideOffline() {
        offline.visibility = View.GONE
        if (!netPill.isVisible) main.removeCallbacks(retryLoop)
    }

    private fun renderSummary(s: MatchSummary?) {
        if (s == null) {
            matchCard.visibility = View.GONE
            return
        }
        val lines = ArrayList<String>()
        s.title?.let { lines += it }
        if (s.home != null || s.away != null) lines += "${s.home ?: "?"} – ${s.away ?: "?"}" + (s.score?.let { "   $it" } ?: "")
        else s.score?.let { lines += it }
        s.sets?.let { lines += it }
        s.state?.let { lines += if (it == "final") "Final" else if (it == "live") "In progress" else it }
        if (lines.isEmpty()) lines += s.backupName
        lines += "Saved " + BackupNames.iso(s.savedAt).replace('T', ' ').take(16) + " UTC"
        matchText.text = lines.joinToString("\n")
        matchCard.visibility = View.VISIBLE
    }

    // ---------------------------------------------------------------- Updates

    private val updateTick = object : Runnable {
        override fun run() {
            maybeCheckUpdate()
            main.postDelayed(this, UPDATE_TICK_MS)
        }
    }

    private fun maybeCheckUpdate() {
        if (resumed && app.boardNetwork.state.value is NetState.Found && app.updates.isCheckDue()) app.updates.check()
    }

    private fun onUpdateState(s: UpdateState) {
        var button: String? = getString(R.string.install)
        val text: String? = when (s) {
            is UpdateState.Available -> {
                if (announcedUpdateCode != s.version.versionCode) {
                    announcedUpdateCode = s.version.versionCode
                    sendEvent(JSONObject().put("type", "update").put("available", true)
                        .put("versionName", s.version.versionName).put("notes", s.version.notes))
                }
                if (app.prefs.dismissedUpdateCode == s.version.versionCode) null
                else getString(R.string.update_available, s.version.versionName)
            }
            is UpdateState.Downloading -> {
                button = null
                "Downloading update ${s.version.versionName}… ${s.bytes / (1024 * 1024)} MB"
            }
            is UpdateState.NeedsPermission -> {
                button = "Continue…"
                "Allow \"Install unknown apps\" for Point Hub to finish the update"
            }
            is UpdateState.Installing -> {
                button = null
                "Installing update ${s.version.versionName}…"
            }
            is UpdateState.Failed -> {
                button = "Retry…"
                if (s.version != null) "Update failed: ${s.message}" else null
            }
            else -> null
        }
        bannerText.text = text
        bannerInstall.text = button
        bannerInstall.visibility = if (button == null) View.GONE else View.VISIBLE
        banner.visibility = if (text == null) View.GONE else View.VISIBLE
    }

    private fun onInstallTapped() {
        when (app.updates.state.value) {
            is UpdateState.Available, is UpdateState.Failed, is UpdateState.NeedsPermission ->
                Ui.askPin(this, "Install the app update") { app.updates.installAvailable(this) }
            else -> Unit
        }
    }

    // ---------------------------------------------------------------- Admin gesture

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN &&
            corner.onDown(ev.x, ev.y, ev.eventTime, Ui.dp(this, 80f))
        ) {
            openAdmin()
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun openAdmin() {
        if (adminOpen || isFinishing) return
        adminOpen = true
        Ui.askPin(this) {
            adminLauncher.launch(Intent(this, AdminActivity::class.java))
        }
        main.postDelayed({ adminOpen = false }, 1000)
    }

    private fun onAdminClosed(result: Int) {
        allowlist = OriginPolicy.Allowlist(app.prefs.overrideOrigin)
        if (result == RESULT_EXIT_APP) {
            // Unpins, and hands HOME back to the other launcher for this exit (otherwise Android
            // relaunches us at once as the home screen); the next start of the app restores both.
            Kiosk.exitApp(this)
            finishAndRemoveTask()
            return
        }
        if (result == AdminActivity.RESULT_RELOAD) {
            forceReload = true
            app.boardNetwork.rediscover()
        }
    }

    // ---------------------------------------------------------------- Lifecycle

    override fun onResume() {
        super.onResume()
        resumed = true
        applyKeepAwake()
        Ui.immersive(this)
        Kiosk.enter(this)
        app.boardNetwork.start()
        main.removeCallbacks(updateTick)
        main.post(updateTick)
    }

    override fun onPause() {
        // Everything keeps running: a system dialog over the console must not stop the match.
        resumed = false
        main.removeCallbacks(updateTick)
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) Ui.immersive(this)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        scope.cancel()
        if (::app.isInitialized && app.prefs.setupDone && isFinishing) app.boardNetwork.stop()
        webView?.let {
            webHolder.removeView(it)
            it.destroy()
        }
        webView = null
        super.onDestroy()
    }

    private fun applyKeepAwake() {
        if (keepAwake) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // ---------------------------------------------------------------- Events to the console

    private fun sendEvent(detail: JSONObject) {
        val wv = webView ?: return
        if (!allowlist.isAllowed(committed.get())) return
        wv.evaluateJavascript("window.dispatchEvent(new CustomEvent('pointhubapp',{detail:$detail}))", null)
    }

    // ---------------------------------------------------------------- BridgeHost (JavaBridge thread)

    override fun committedOrigin(): String? = committed.get()
    override val backups: BackupStore get() = app.backups
    override val schedule: ScheduleStore get() = app.schedule
    override fun infoJson(): String = AppInfo.json(this, app).toString()

    override fun setKeepAwake(on: Boolean) {
        keepAwake = on
        main.post { applyKeepAwake() }
    }

    override fun startExport(): Boolean {
        if (app.backups.list().isEmpty()) return false
        if (!exporting.compareAndSet(false, true)) return false
        main.post {
            // The save-file picker opens in our task: the tablet stays pinned.
            val launched = Kiosk.launchInTask { exportLauncher.launch(BackupExporter.defaultName()) }
            if (!launched) {
                exporting.set(false)
                sendEvent(JSONObject().put("type", "export").put("ok", false).put("reason", "io"))
            }
        }
        return true
    }

    private fun onExportTarget(uri: android.net.Uri?) {
        if (uri == null) {
            exporting.set(false)
            sendEvent(JSONObject().put("type", "export").put("ok", false).put("reason", "cancelled"))
            return
        }
        thread(name = "export") {
            val event = try {
                val n = BackupExporter.write(this, app, uri)
                JSONObject().put("type", "export").put("ok", true).put("files", n)
            } catch (e: Exception) {
                Log.w(TAG, "export failed", e)
                JSONObject().put("type", "export").put("ok", false).put("reason", "io")
            }
            exporting.set(false)
            main.post { sendEvent(event) }
        }
    }

    override fun reloadConsole() {
        main.post {
            forceReload = true
            app.boardNetwork.rediscover()
        }
    }

    override fun openSettings() {
        main.post { openAdmin() }
    }
}
