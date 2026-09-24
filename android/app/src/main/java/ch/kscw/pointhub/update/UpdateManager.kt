package ch.kscw.pointhub.update

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.net.toUri
import ch.kscw.pointhub.PointHubApp
import ch.kscw.pointhub.kiosk.Kiosk
import ch.kscw.pointhub.net.HttpProbe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

sealed class UpdateState {
    data object Idle : UpdateState()
    data object Checking : UpdateState()
    data class UpToDate(val remote: AppVersion?) : UpdateState()
    data class Available(val version: AppVersion) : UpdateState()
    data class Downloading(val version: AppVersion, val bytes: Long) : UpdateState()
    /** Downloaded and verified; waiting for "Install unknown apps" to be allowed. */
    data class NeedsPermission(val version: AppVersion, val file: File) : UpdateState()
    data class Installing(val version: AppVersion) : UpdateState()
    data class Failed(val message: String, val version: AppVersion?) : UpdateState()
}

/**
 * Self-update from the board: GET /app/version.json, download the APK over the bound network,
 * verify its sha256, package name, version and signing certificate, then install with a
 * PackageInstaller session. Silent when device owner, or (API 31+) once this app is its own
 * installer of record; otherwise Android asks the user once per update.
 */
class UpdateManager(private val app: PointHubApp) {
    companion object {
        private const val TAG = "UpdateManager"
        const val CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000
        private const val MAX_APK_BYTES = 150L * 1024 * 1024
        private const val MAX_DOWNLOAD_MS = 5L * 60 * 1000
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state

    /** A system confirmation screen waiting for an activity in front to show it. */
    @Volatile private var pendingConfirm: Intent? = null
    @Volatile private var checkedThisProcess = false

    val installedVersionCode: Long
        get() = PackageInfoCompat.getLongVersionCode(app.packageManager.getPackageInfo(app.packageName, 0))

    /** Due on the first resume after process start, then every 6 h. */
    fun isCheckDue(now: Long = System.currentTimeMillis()): Boolean =
        !checkedThisProcess || now - app.prefs.lastUpdateCheck >= CHECK_INTERVAL_MS

    fun check(force: Boolean = false, onDone: ((UpdateState) -> Unit)? = null) {
        val s = _state.value
        if (s is UpdateState.Checking || s is UpdateState.Downloading || s is UpdateState.Installing) return
        if (!force && !isCheckDue()) return
        val origin = app.boardNetwork.currentOrigin
        if (origin == null) {
            if (force) _state.value = UpdateState.Failed("Scoreboard not reachable", null)
            onDone?.invoke(_state.value)
            return
        }
        val network = app.boardNetwork.currentNetwork
        _state.value = UpdateState.Checking
        scope.launch {
            checkedThisProcess = true
            app.prefs.lastUpdateCheck = System.currentTimeMillis()
            val next = try {
                val conn = HttpProbe.open(URL("$origin/app/version.json"), network)
                conn.instanceFollowRedirects = false
                conn.connectTimeout = 3000
                conn.readTimeout = 5000
                conn.useCaches = false
                conn.setRequestProperty("Cache-Control", "no-cache")
                try {
                    if (conn.responseCode != 200) {
                        UpdateState.UpToDate(null)
                    } else {
                        val body = HttpProbe.readCapped(conn.inputStream, 64 * 1024)
                        val v = body?.let { AppVersion.parse(it, origin) }
                        when {
                            v == null -> UpdateState.UpToDate(null).also { Log.w(TAG, "version.json invalid") }
                            AppVersion.isNewer(v, installedVersionCode) -> UpdateState.Available(v)
                            else -> UpdateState.UpToDate(v)
                        }
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (e: IOException) {
                Log.i(TAG, "update check failed: $e")
                if (force) UpdateState.Failed("Check failed: ${e.javaClass.simpleName}", null) else UpdateState.UpToDate(null)
            }
            // Never overwrite a newer state that arrived meanwhile (e.g. an install started).
            if (_state.value is UpdateState.Checking) _state.value = next
            onDone?.invoke(_state.value)
        }
    }

    /** Download, verify, install. Call from an activity in front (admin PIN already checked). */
    fun installAvailable(activity: Activity) {
        when (val s = _state.value) {
            is UpdateState.Available -> scope.launch { downloadAndInstall(s.version) }
            is UpdateState.Failed -> s.version?.let { v -> scope.launch { downloadAndInstall(v) } }
            is UpdateState.NeedsPermission -> continueAfterPermission(activity)
            else -> Unit
        }
    }

    private fun downloadAndInstall(v: AppVersion) {
        val file = try {
            download(v)
        } catch (e: Exception) {
            Log.w(TAG, "download failed", e)
            _state.value = UpdateState.Failed("Download failed: ${e.message ?: e.javaClass.simpleName}", v)
            return
        }
        val problem = checkArchive(file, v)
        if (problem != null) {
            file.delete()
            _state.value = UpdateState.Failed(problem, v)
            return
        }
        if (!app.packageManager.canRequestPackageInstalls() && !Kiosk.isDeviceOwner(app)) {
            _state.value = UpdateState.NeedsPermission(v, file)
            app.resumedActivity?.let { a -> a.runOnUiThread { openInstallPermission(a) } }
            return
        }
        commit(v, file)
    }

    private fun download(v: AppVersion): File {
        val dir = File(app.cacheDir, "update").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val part = File(dir, "pointhub-${v.versionCode}.apk.part")
        val conn = HttpProbe.open(URL(v.apkUrl), app.boardNetwork.currentNetwork)
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 5000
        conn.readTimeout = 15000
        conn.useCaches = false
        val started = System.currentTimeMillis()
        val md = Sha256.newDigest()
        var total = 0L
        try {
            if (conn.responseCode != HttpURLConnection.HTTP_OK) throw IOException("HTTP ${conn.responseCode}")
            conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var lastReport = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_APK_BYTES) throw IOException("APK larger than 150 MB")
                        if (System.currentTimeMillis() - started > MAX_DOWNLOAD_MS) throw IOException("download took over 5 minutes")
                        md.update(buf, 0, n)
                        out.write(buf, 0, n)
                        if (total - lastReport > 256 * 1024) {
                            lastReport = total
                            _state.value = UpdateState.Downloading(v, total)
                        }
                    }
                    out.fd.sync()
                }
            }
        } finally {
            conn.disconnect()
        }
        if (!Sha256.matches(md.digest(), v.sha256)) {
            part.delete()
            throw IOException("checksum mismatch")
        }
        val apk = File(dir, "pointhub-${v.versionCode}.apk")
        if (!part.renameTo(apk)) throw IOException("rename failed")
        return apk
    }

    /** Package name, version and signer must match before we hand it to the installer. */
    private fun checkArchive(file: File, v: AppVersion): String? {
        val pm = app.packageManager
        val info = (if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageArchiveInfo(file.path, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        } else if (Build.VERSION.SDK_INT >= 28) {
            pm.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES)
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNATURES)
        }) ?: return "Downloaded file is not a valid APK"
        if (info.packageName != app.packageName) return "APK is for ${info.packageName}, not this app"
        val code = PackageInfoCompat.getLongVersionCode(info)
        if (code <= installedVersionCode) return "APK version $code is not newer than the installed one"
        if (code != v.versionCode.toLong()) return "APK version $code does not match version.json (${v.versionCode})"
        val installed = signerDigests(if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(app.packageName, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        } else if (Build.VERSION.SDK_INT >= 28) {
            pm.getPackageInfo(app.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(app.packageName, PackageManager.GET_SIGNATURES)
        })
        val incoming = signerDigests(info)
        if (incoming.isEmpty() || incoming != installed) return "APK is signed with a different key; refusing to install"
        return null
    }

    private fun signerDigests(info: android.content.pm.PackageInfo): Set<String> {
        val sigs = if (Build.VERSION.SDK_INT >= 28) {
            info.signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION")
            info.signatures
        } ?: return emptySet()
        return sigs.map { Sha256.hex(Sha256.of(it.toByteArray())) }.toSet()
    }

    fun openInstallPermission(activity: Activity) {
        Kiosk.suspendFor(activity) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${activity.packageName}".toUri()))
        }
    }

    private fun continueAfterPermission(activity: Activity) {
        val s = _state.value as? UpdateState.NeedsPermission ?: return
        if (!app.packageManager.canRequestPackageInstalls()) {
            openInstallPermission(activity)
            return
        }
        scope.launch { commit(s.version, s.file) }
    }

    private fun commit(v: AppVersion, file: File) {
        _state.value = UpdateState.Installing(v)
        try {
            val pi = app.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(app.packageName)
                setSize(file.length())
                setInstallReason(PackageManager.INSTALL_REASON_USER)
                if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                if (Build.VERSION.SDK_INT >= 33) setPackageSource(PackageInstaller.PACKAGE_SOURCE_OTHER)
            }
            val id = pi.createSession(params)
            pi.openSession(id).use { session ->
                session.openWrite("base.apk", 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val intent = Intent(app, InstallResultReceiver::class.java).setPackage(app.packageName)
                // The installer fills in extras, so the PendingIntent must be mutable (explicit target).
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                session.commit(PendingIntent.getBroadcast(app, id, intent, flags).intentSender)
            }
        } catch (e: Exception) {
            Log.w(TAG, "install session failed", e)
            _state.value = UpdateState.Failed("Install failed: ${e.message ?: e.javaClass.simpleName}", v)
        }
    }

    /** From [InstallResultReceiver]. */
    fun onInstallStatus(status: Int, message: String?, confirm: Intent?) {
        val v = (_state.value as? UpdateState.Installing)?.version
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                if (confirm == null) return
                pendingConfirm = confirm
                app.resumedActivity?.let { a -> a.runOnUiThread { onActivityResumed(a) } }
            }
            PackageInstaller.STATUS_SUCCESS -> Log.i(TAG, "update installed")
            else -> {
                File(app.cacheDir, "update").listFiles()?.forEach { it.delete() }
                _state.value = UpdateState.Failed("Install failed (status $status): ${message ?: "unknown"}", v)
            }
        }
    }

    /**
     * Android 14/15 forbid starting the installer's confirmation from a receiver; an activity in
     * front may. Called for every resumed activity of ours.
     */
    fun onActivityResumed(activity: Activity) {
        val confirm = pendingConfirm ?: run {
            if (_state.value is UpdateState.NeedsPermission &&
                app.packageManager.canRequestPackageInstalls()
            ) continueAfterPermission(activity)
            return
        }
        pendingConfirm = null
        Kiosk.suspendFor(activity) { activity.startActivity(confirm) }
    }
}
