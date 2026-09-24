package ch.kscw.pointhub.web

import android.util.Log
import android.webkit.JavascriptInterface
import ch.kscw.pointhub.store.BackupNames
import ch.kscw.pointhub.store.BackupStore
import ch.kscw.pointhub.store.ScheduleStore

/** What the bridge needs from its activity. Methods may be called on the JavaBridge thread. */
interface BridgeHost {
    /** The main-frame origin last committed on the UI thread (null when offline / not a board page). */
    fun committedOrigin(): String?
    val allowlist: OriginPolicy.Allowlist
    val backups: BackupStore
    val schedule: ScheduleStore
    fun infoJson(): String
    fun setKeepAwake(on: Boolean)
    /** Returns false when an export is already running or there is nothing to export. */
    fun startExport(): Boolean
    fun reloadConsole()
    fun openSettings()
}

/**
 * `window.PointHubApp`: the contract in android/BRIDGE.md. Every method re-checks that the page
 * currently committed in the main frame is a board origin, and returns the documented "denied"
 * value (null / false / "{}" / "[]") otherwise. Inputs are length-capped.
 */
class PointHubBridge(private val host: BridgeHost) {
    companion object {
        const val NAME = "PointHubApp"
        private const val TAG = "PointHubBridge"
    }

    private fun allowed(method: String): Boolean {
        val origin = host.committedOrigin()
        val ok = host.allowlist.isAllowed(origin)
        if (!ok) Log.w(TAG, "denied $method for origin=$origin")
        return ok
    }

    @JavascriptInterface
    fun getInfo(): String = if (allowed("getInfo")) host.infoJson() else "{}"

    @JavascriptInterface
    fun keepAwake(on: Boolean) {
        if (allowed("keepAwake")) host.setKeepAwake(on)
    }

    @JavascriptInterface
    fun saveBackup(name: String?, json: String?): Boolean {
        if (!allowed("saveBackup") || json == null) return false
        if (name != null && name.length > BackupNames.MAX_NAME) return false
        return try {
            host.backups.save(name, json) != null
        } catch (e: Exception) {
            Log.w(TAG, "saveBackup failed", e)
            false
        }
    }

    @JavascriptInterface
    fun listBackups(): String = if (allowed("listBackups")) host.backups.listJson() else "[]"

    @JavascriptInterface
    fun exportBackups(): Boolean = allowed("exportBackups") && host.startExport()

    @JavascriptInterface
    fun saveSchedule(json: String?): Boolean {
        if (!allowed("saveSchedule") || json == null) return false
        return try {
            host.schedule.save(json)
        } catch (e: Exception) {
            Log.w(TAG, "saveSchedule failed", e)
            false
        }
    }

    @JavascriptInterface
    fun loadSchedule(): String? = if (allowed("loadSchedule")) host.schedule.load() else null

    @JavascriptInterface
    fun reloadConsole() {
        if (allowed("reloadConsole")) host.reloadConsole()
    }

    @JavascriptInterface
    fun openSettings() {
        if (allowed("openSettings")) host.openSettings()
    }
}
