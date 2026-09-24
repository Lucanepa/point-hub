package ch.kscw.pointhub.net

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import ch.kscw.pointhub.PointHubApp
import ch.kscw.pointhub.kiosk.Kiosk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.Executors

/** How the board is reached. */
enum class LinkKind { WIFI, ETHERNET, DEFAULT }

sealed class NetState {
    data object Idle : NetState()
    data class Searching(val attempt: Int) : NetState()
    data class Found(val origin: String, val network: Network?, val kind: LinkKind) : NetState()
    data class NotFound(val failures: List<Pair<String, ProbeResult.Fail>>, val lanFound: Boolean, val hint: Hint?) : NetState()
    /** The bound board network went away and did not come back within the grace period. */
    data object Lost : NetState()
}

enum class Hint { CLOCK, NO_WIFI_PERMISSION, WIFI_REQUEST_DECLINED, NO_WIFI_CONFIGURED }

/**
 * Finds the board and pins this process's traffic (HttpURLConnection AND the WebView) to the
 * network it is on. The board LAN is recognised by reachability, not by SSID (reading the SSID
 * needs location). We bind only when the board LAN is actually found, so the Tailscale path
 * (VPN over hall Wi-Fi) is not bypassed. All state changes run on one thread.
 *
 * Rules that keep a live match alive:
 * - A discovery request that arrives while one is running is queued, never dropped.
 * - The binding is only dropped when the bound network is actually lost (onLost), never because
 *   one re-probe of a busy board timed out.
 * - A board found over the default network (no LAN bound) is still watched: a board Wi-Fi or
 *   cable appearing moves us onto it without a reload, and losing the default network runs the
 *   same grace period and Lost path as losing a bound LAN.
 */
class BoardNetwork(private val app: PointHubApp) {
    companion object {
        private const val TAG = "BoardNetwork"
        private const val LOST_GRACE_MS = 5_000L
        private const val DEBOUNCE_MS = 500L
        /** Let the initial onAvailable callbacks arrive before the first discovery. */
        private const val STARTUP_SETTLE_MS = 400L
    }

    private val cm = app.getSystemService(ConnectivityManager::class.java)
    private val dispatcher = Executors.newSingleThreadExecutor { r -> Thread(r, "board-network") }.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val _state = MutableStateFlow<NetState>(NetState.Idle)
    val state: StateFlow<NetState> = _state

    /** Human-readable progress for the offline screen ("Trying https…"). */
    private val _progress = MutableStateFlow("")
    val progress: StateFlow<String> = _progress

    private val wifiNets = LinkedHashSet<Network>()
    private val ethNets = LinkedHashSet<Network>()
    private var defaultNet: Network? = null
    private var bound: Network? = null
    private var started = false
    private var discoverJob: Job? = null
    private var rerunPending = false
    private var debounceJob: Job? = null
    private var graceJob: Job? = null
    private var upgradeJob: Job? = null
    private var startJob: Job? = null
    private var attempt = 0
    private var specCb: ConnectivityManager.NetworkCallback? = null
    private var specNetwork: Network? = null
    private var autoSpecifierTried = false
    private var lastHint: Hint? = null
    private val demoted = HashMap<String, Long>()
    /** A plain (no specifier, no dialog) request that marks the bound board LAN as needed. */
    private var keepAliveCb: ConnectivityManager.NetworkCallback? = null
    private var keepAliveKind: LinkKind? = null

    /** The network page loads and downloads must use right now (null = process default). */
    val currentNetwork: Network? get() = (state.value as? NetState.Found)?.network
    val currentOrigin: String? get() = (state.value as? NetState.Found)?.origin

    private fun trackCallback(set: MutableSet<Network>) = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            scope.launch { set.add(network); onNetworksChanged() }
        }
        override fun onLost(network: Network) {
            scope.launch { set.remove(network); onNetworkGone(network) }
        }
    }

    private val wifiCb = trackCallback(wifiNets)
    private val ethCb = trackCallback(ethNets)

    /** The system default network: what a Found(DEFAULT) board is reached over. */
    private val defaultCb = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            scope.launch {
                val prev = defaultNet
                defaultNet = network
                if (prev != null && prev != network) onDefaultChanged()
            }
        }
        override fun onLost(network: Network) {
            scope.launch {
                if (defaultNet == network) {
                    defaultNet = null
                    onDefaultChanged()
                }
            }
        }
    }

    fun start() {
        scope.launch {
            if (started) return@launch
            started = true
            try {
                // The default request carries INTERNET; removing it is what lets the board's
                // no-internet AP (and a specifier network) match.
                cm.registerNetworkCallback(
                    NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                        .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), wifiCb)
                cm.registerNetworkCallback(
                    NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
                        .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), ethCb)
                cm.registerDefaultNetworkCallback(defaultCb)
            } catch (e: Exception) {
                Log.w(TAG, "registerNetworkCallback failed", e)
            }
            // Registering delivers onAvailable for the networks that are already up, but
            // asynchronously: a discovery started right now would see no Wi-Fi at all, skip the
            // LAN step and settle on the default network unbound.
            startJob = scope.launch {
                delay(STARTUP_SETTLE_MS)
                discoverLocked()
            }
        }
    }

    fun stop() {
        scope.launch {
            if (!started) return@launch
            started = false
            for (cb in listOf(wifiCb, ethCb, defaultCb)) try { cm.unregisterNetworkCallback(cb) } catch (_: Exception) {}
            listOf(startJob, debounceJob, graceJob, upgradeJob, discoverJob).forEach { it?.cancel() }
            rerunPending = false
            releaseSpecifier()
            wifiNets.clear(); ethNets.clear(); defaultNet = null
            bind(null)
            _state.value = NetState.Idle
        }
    }

    /** The offline screen's periodic retry: starts a discovery unless one is already running. */
    fun discover() {
        scope.launch { discoverLocked(queue = false) }
    }

    /** Forget the current result and search again; a Found state is re-published afterwards. */
    fun rediscover() {
        scope.launch {
            if (_state.value is NetState.Found) _state.value = NetState.Searching(++attempt)
            discoverLocked()
        }
    }

    /**
     * Starts a discovery. When one is already running, [queue] makes it run once more afterwards,
     * so an event that arrives mid-discovery (a network appearing) is never lost.
     */
    private fun discoverLocked(queue: Boolean = true) {
        if (!started) return
        if (discoverJob?.isActive == true) {
            if (queue) rerunPending = true
            return
        }
        discoverJob = scope.launch {
            do {
                rerunPending = false
                runDiscovery()
            } while (rerunPending && started)
        }
    }

    private fun isTracked(n: Network) = n in wifiNets || n in ethNets || n == specNetwork
    private fun kindOf(n: Network) = if (n in ethNets) LinkKind.ETHERNET else LinkKind.WIFI

    private fun onNetworksChanged() {
        val s = _state.value
        if (s is NetState.Found) {
            // A healthy board on a bound LAN is left alone: a Wi-Fi signal change must not reload
            // a live match. A board found over the default network is moved onto a board LAN if
            // one has just appeared.
            if (s.network == null) scheduleUpgrade()
            if (s.network == null || isTracked(s.network)) return
        }
        debounceJob?.cancel()
        debounceJob = scope.launch { delay(DEBOUNCE_MS); discoverLocked() }
    }

    private fun onNetworkGone(network: Network) {
        if (network == specNetwork) specNetwork = null
        if (bound != null && network == bound) {
            Log.i(TAG, "board network lost")
            bind(null)
            if (_state.value is NetState.Found) {
                beginGrace()
                return
            }
        }
        // A discovery running right now may still be probing the network that just went away.
        if (discoverJob?.isActive == true) rerunPending = true
        onNetworksChanged()
    }

    /** The system default network changed or went away. Only matters for a Found(DEFAULT) board. */
    private fun onDefaultChanged() {
        val s = _state.value
        if (s is NetState.Found && s.network == null) {
            Log.i(TAG, "default network changed under a default-network board")
            beginGrace()
        }
    }

    /**
     * The board's link went away: search for up to [LOST_GRACE_MS]; if it is not found again by
     * then, publish Lost. A live console page stays up meanwhile (Searching changes nothing there).
     */
    private fun beginGrace() {
        _state.value = NetState.Searching(++attempt)
        graceJob?.cancel()
        graceJob = scope.launch {
            val until = System.currentTimeMillis() + LOST_GRACE_MS
            while (System.currentTimeMillis() < until) {
                discoverLocked()
                discoverJob?.join()
                if (_state.value is NetState.Found) return@launch
                delay(1000)
            }
            if (_state.value !is NetState.Found) _state.value = NetState.Lost
        }
    }

    /**
     * Found over the default network, and a Wi-Fi / Ethernet network appeared: if it is the board
     * LAN and the page's origin answers there, bind to it and republish Found with the SAME origin,
     * so the page is not reloaded but its link loss is now detected.
     */
    private fun scheduleUpgrade() {
        upgradeJob?.cancel()
        upgradeJob = scope.launch {
            delay(DEBOUNCE_MS)
            val s = _state.value as? NetState.Found ?: return@launch
            if (s.network != null) return@launch
            val lan = findBoardLan() ?: return@launch
            val ok = BoardProber.pick(listOf(s.origin)) { HttpProbe.probe(it, lan.first) } is PickResult.Found
            val cur = _state.value
            if (!ok || cur !is NetState.Found || cur.network != null || cur.origin != s.origin || !isTracked(lan.first)) return@launch
            Log.i(TAG, "board LAN appeared; binding ${lan.second} under ${s.origin}")
            bind(lan.first)
            _state.value = NetState.Found(s.origin, lan.first, lan.second)
        }
    }

    private fun bind(network: Network?) {
        if (bound != network) {
            val ok = try { cm.bindProcessToNetwork(network) } catch (e: Exception) { Log.w(TAG, "bind failed", e); false }
            if (!ok) Log.w(TAG, "bindProcessToNetwork($network) returned false")
            bound = network
        }
        holdNetwork(network?.let { kindOf(it) })
    }

    /**
     * Listening callbacks and bindProcessToNetwork do not keep a network up. On a tablet with
     * mobile data, the unvalidated board AP then satisfies no request and may be torn down or
     * deprioritised as unneeded. A plain request (no specifier: no dialog, satisfied by the
     * connected AP / cable) marks it as needed while we are bound to it.
     */
    private fun holdNetwork(kind: LinkKind?) {
        if (kind == keepAliveKind) return
        keepAliveCb?.let { try { cm.unregisterNetworkCallback(it) } catch (_: Exception) {} }
        keepAliveCb = null
        keepAliveKind = null
        if (kind == null || kind == LinkKind.DEFAULT) return
        val transport = if (kind == LinkKind.ETHERNET) NetworkCapabilities.TRANSPORT_ETHERNET else NetworkCapabilities.TRANSPORT_WIFI
        val cb = object : ConnectivityManager.NetworkCallback() {}
        try {
            cm.requestNetwork(
                NetworkRequest.Builder().addTransportType(transport)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), cb)
            keepAliveCb = cb
            keepAliveKind = kind
        } catch (e: Exception) {
            Log.w(TAG, "keep-alive request failed", e)
        }
    }

    private suspend fun runDiscovery() {
        attempt++
        if (_state.value !is NetState.Found) _state.value = NetState.Searching(attempt)
        val now = System.currentTimeMillis()
        demoted.entries.removeAll { it.value < now }
        fun usable(all: List<String>) = all.filter { it !in demoted }.ifEmpty { all }
        val override = app.prefs.overrideOrigin

        // 1. Find the board LAN: probe each tracked Wi-Fi / Ethernet network for the board IP.
        _progress.value = "Looking on Wi-Fi and cable…"
        var lan = findBoardLan()
        val b = bound
        if (lan == null && b != null && isTracked(b)) {
            // The bound board LAN is still up; one slow answer from a busy board must not move
            // live sockets to mobile data. Probe once more, and keep the binding either way:
            // only onLost drops it.
            lan = findBoardLan() ?: (b to kindOf(b))
        }
        if (lan != null && !isTracked(lan.first)) lan = null // went away while we probed
        val result: PickResult
        val kind: LinkKind
        if (lan != null) {
            bind(lan.first)
            kind = lan.second
            // A saved-network path works: the app-scoped specifier connection is no longer needed.
            if (specCb != null && lan.first != specNetwork) releaseSpecifier()
            result = BoardProber.pick(usable(BoardEndpoints.candidates(override))) { origin ->
                _progress.value = "Trying ${label(origin)}…"
                HttpProbe.probe(origin, lan.first)
            }
        } else {
            // 2. No board LAN: the default network, e.g. hall Wi-Fi + Tailscale MagicDNS. Only
            //    https here: the plain-http board IPs are only trusted on the board LAN itself.
            bind(null)
            kind = LinkKind.DEFAULT
            result = BoardProber.pick(usable(BoardEndpoints.defaultNetworkCandidates(override))) { origin ->
                _progress.value = "Trying ${label(origin)}…"
                HttpProbe.probe(origin, null)
            }
        }
        when (result) {
            is PickResult.Found -> {
                graceJob?.cancel()
                lastHint = null
                app.prefs.lastOrigin = result.origin
                _progress.value = "Found ${label(result.origin)}"
                _state.value = NetState.Found(result.origin, lan?.first, kind)
            }
            is PickResult.NotFound -> {
                var hint = lastHint
                if (result.failures.any { it.second.reason == FailReason.TLS_DATE }) hint = Hint.CLOCK
                // 3. Last resort, at most once per process run automatically: ask Android for the
                //    AP. Only when the tablet is on no Wi-Fi / cable at all (never to "re-join" an
                //    AP it is already on because the board's server is restarting), and only when
                //    not pinned: the system's "Connect to device" dialog opens in another task,
                //    which lock task blocks. Pinned, the offline screen's button does it (PIN).
                if (!autoSpecifierTried && specCb == null && specNetwork == null &&
                    wifiNets.isEmpty() && ethNets.isEmpty() &&
                    Kiosk.lockTaskState(app) == ActivityManager.LOCK_TASK_MODE_NONE
                ) {
                    autoSpecifierTried = true
                    requestBoardWifiLocked()?.let { hint = it }
                }
                _progress.value = ""
                _state.value = NetState.NotFound(result.failures, lan != null, hint)
            }
        }
    }

    private suspend fun findBoardLan(): Pair<Network, LinkKind>? = coroutineScope {
        val nets = wifiNets.map { it to LinkKind.WIFI } + ethNets.map { it to LinkKind.ETHERNET } +
            listOfNotNull(specNetwork?.takeIf { it !in wifiNets }?.let { it to LinkKind.WIFI })
        if (nets.isEmpty()) return@coroutineScope null
        val results = nets.map { (n, k) ->
            async {
                val origin = BoardEndpoints.lanProbeOrigin(ethernet = k == LinkKind.ETHERNET)
                val r = BoardProber.pick(listOf(origin)) { HttpProbe.probe(it, n) }
                if (r is PickResult.Found) n to k else null
            }
        }.awaitAll().filterNotNull()
        results.firstOrNull { it.second == LinkKind.WIFI } ?: results.firstOrNull()
    }

    private fun label(origin: String): String = when {
        origin.startsWith("https://") -> "https"
        origin.contains("172.24.1.1") -> "172.24.1.1"
        origin.contains("192.168.5.1") -> "cable"
        else -> origin
    }

    /**
     * The WebView failed on [origin] although its probe answered (e.g. a certificate the WebView
     * rejects): skip it for a minute so discovery falls back instead of reloading it every 3 s.
     */
    fun demote(origin: String?) {
        if (origin == null) return
        scope.launch {
            demoted[origin] = System.currentTimeMillis() + 60_000
            val s = _state.value
            if (s is NetState.Found && s.origin == origin) _state.value = NetState.Searching(++attempt)
            discoverLocked()
        }
    }

    /**
     * The offline page's "Connect to scoreboard Wi-Fi" button. The caller (MainActivity) must
     * have left lock task first (admin PIN): the system dialog opens in another task.
     */
    fun requestBoardWifi() {
        scope.launch {
            releaseSpecifier()
            val hint = requestBoardWifiLocked()
            lastHint = hint
            val s = _state.value
            if (hint != null && s is NetState.NotFound) _state.value = s.copy(hint = hint)
        }
    }

    /** Returns a hint when the request could not even be made. */
    private fun requestBoardWifiLocked(): Hint? {
        if (Build.VERSION.SDK_INT < 29) return null
        if (!app.prefs.wifiConfigured) return Hint.NO_WIFI_CONFIGURED
        val pass = app.secrets.wifiPassphrase() ?: return Hint.NO_WIFI_CONFIGURED
        if (!hasWifiRequestPermission(app)) return Hint.NO_WIFI_PERMISSION
        val spec = WifiNetworkSpecifier.Builder().setSsid(app.prefs.ssid).setWpa2Passphrase(pass).build()
        val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(spec).build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch { specNetwork = network; discoverLocked() }
            }
            override fun onUnavailable() {
                // Declined in the dialog, OR not found within the timeout: we cannot tell which.
                scope.launch {
                    specCb = null
                    lastHint = Hint.WIFI_REQUEST_DECLINED
                    val s = _state.value
                    if (s is NetState.NotFound) _state.value = s.copy(hint = Hint.WIFI_REQUEST_DECLINED)
                }
            }
            override fun onLost(network: Network) {
                scope.launch { if (specNetwork == network) specNetwork = null; onNetworkGone(network) }
            }
        }
        return try {
            cm.requestNetwork(req, cb, 30_000)
            specCb = cb
            null
        } catch (e: SecurityException) {
            Log.w(TAG, "specifier request refused", e)
            Hint.NO_WIFI_PERMISSION
        } catch (e: Exception) {
            Log.w(TAG, "specifier request failed", e)
            null
        }
    }

    private fun releaseSpecifier() {
        specCb?.let { try { cm.unregisterNetworkCallback(it) } catch (_: Exception) {} }
        specCb = null
        specNetwork = null
    }
}

fun hasWifiRequestPermission(ctx: Context): Boolean {
    val perm = wifiRequestPermission() ?: return true
    return ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED
}

/** NEARBY_WIFI_DEVICES on 33+, fine location on 29–32, nothing before. */
fun wifiRequestPermission(): String? = when {
    Build.VERSION.SDK_INT >= 33 -> Manifest.permission.NEARBY_WIFI_DEVICES
    Build.VERSION.SDK_INT >= 29 -> Manifest.permission.ACCESS_FINE_LOCATION
    else -> null
}
