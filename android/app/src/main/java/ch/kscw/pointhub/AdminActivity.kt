package ch.kscw.pointhub

import android.app.AlertDialog
import android.app.role.RoleManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.net.toUri
import ch.kscw.pointhub.kiosk.Kiosk
import ch.kscw.pointhub.net.NetState
import ch.kscw.pointhub.ui.Ui
import ch.kscw.pointhub.update.UpdateState
import ch.kscw.pointhub.web.OriginPolicy
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.concurrent.thread

/** The hidden admin menu (reached with 5 taps top-left + the app-local admin PIN). */
class AdminActivity : ComponentActivity() {
    companion object {
        const val RESULT_RELOAD = 101
    }

    private lateinit var app: PointHubApp
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private val scope = MainScope()
    private val dynamicButtons = ArrayList<Button>()
    private lateinit var exportLauncher: ActivityResultLauncher<String>
    private lateinit var roleLauncher: ActivityResultLauncher<Intent>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app = pointHub
        setContentView(R.layout.activity_admin)
        list = findViewById(R.id.adminList)
        status = findViewById(R.id.adminStatus)
        exportLauncher = registerForActivityResult(BackupExporter.CreateZip()) { uri ->
            if (uri == null) return@registerForActivityResult
            thread(name = "admin-export") {
                val msg = try {
                    "Exported ${BackupExporter.write(this, app, uri)} backups"
                } catch (e: Exception) {
                    "Export failed: ${e.message}"
                }
                runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }
            }
        }
        roleLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { render() }
        scope.launch { app.updates.state.collect { render() } }
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun button(label: String, primary: Boolean = false, action: () -> Unit) {
        val b = Button(this, null, 0, if (primary) R.style.PH_Button else R.style.PH_Button_Plain)
        b.text = label
        b.setOnClickListener { action() }
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.topMargin = Ui.dp(this, 8f).toInt()
        list.addView(b, lp)
        dynamicButtons += b
    }

    private fun render() {
        dynamicButtons.forEach { list.removeView(it) }
        dynamicButtons.clear()
        val net = app.boardNetwork.state.value
        val upd = app.updates.state.value
        val owner = Kiosk.isDeviceOwner(this)
        val home = Kiosk.isHomeAliasEnabled(this)
        status.text = buildString {
            append("Point Hub ${AppInfo.versionName(this@AdminActivity)} (${AppInfo.versionCode(this@AdminActivity)})")
            append(" · ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}\n")
            append("Board: ").append(if (net is NetState.Found) "${net.origin} via ${net.kind.name.lowercase()}" else "not found").append('\n')
            append("Wi-Fi: ${app.prefs.ssid}").append(if (app.prefs.wifiConfigured) "" else " (not configured)").append('\n')
            app.prefs.overrideOrigin?.let { append("URL override: $it\n") }
            append("Kiosk: ${Kiosk.lockTaskLabel(this@AdminActivity)}")
            append(if (owner) " · device owner" else "").append(if (home) " · home screen" else "").append('\n')
            append("Update: ").append(when (upd) {
                is UpdateState.Available -> "${upd.version.versionName} available. ${upd.version.notes}"
                is UpdateState.UpToDate -> "up to date" + (upd.remote?.let { " (board has ${it.versionName})" } ?: "")
                is UpdateState.Checking -> "checking…"
                is UpdateState.Downloading -> "downloading ${upd.bytes / 1024} KB…"
                is UpdateState.NeedsPermission -> "allow \"Install unknown apps\" for Point Hub"
                is UpdateState.Installing -> "installing…"
                is UpdateState.Failed -> upd.message
                UpdateState.Idle -> "not checked yet"
            })
        }

        button("Back to the console", primary = true) { finish() }
        if (upd is UpdateState.Available || (upd is UpdateState.Failed && upd.version != null) || upd is UpdateState.NeedsPermission) {
            button("Install app update", primary = true) { app.updates.installAvailable(this) }
        }
        button("Check for app update") { app.updates.check(force = true) }
        button("Reload console") { setResult(RESULT_RELOAD); finish() }
        button("Wi-Fi setup") { startActivity(Intent(this, SetupActivity::class.java)) }
        button("Board URL override") { editOverride() }
        button("Change admin PIN") { Ui.changePin(this) { Toast.makeText(this, "PIN changed", Toast.LENGTH_SHORT).show() } }
        button("Export backups") {
            if (app.backups.list().isEmpty()) Toast.makeText(this, "No backups on this tablet yet", Toast.LENGTH_SHORT).show()
            else Kiosk.launchInTask { exportLauncher.launch(BackupExporter.defaultName()) }
        }
        if (app.kioskSuspended) {
            button("Resume kiosk") { Kiosk.resume(this); setResult(RESULT_OK); finish() }
        } else {
            button("Exit kiosk (unpin until next start)") { Kiosk.exit(this); render() }
        }
        if (!owner) {
            button(if (app.prefs.kioskPinning) "Screen pinning at start: ON (turn off)" else "Screen pinning at start: OFF (turn on)") {
                app.prefs.kioskPinning = !app.prefs.kioskPinning
                render()
            }
        }
        if (home) button("Stop being the home screen") { Kiosk.setHomeAliasEnabled(this, false); render() }
        else button("Use as home screen (starts at boot)") { becomeHome() }
        button("Android settings") {
            Kiosk.suspendFor(this) { startActivity(Intent(Settings.ACTION_SETTINGS)) }
        }
        button("App info (permissions)") {
            Kiosk.suspendFor(this) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri()))
            }
        }
        if (owner) button("Remove device owner") { confirmRemoveOwner() }
        button("Exit app") { setResult(MainActivity.RESULT_EXIT_APP); finish() }
    }

    private fun editOverride() {
        val field = EditText(this).apply {
            hint = "e.g. http://172.24.1.1:8890 (empty = automatic)"
            setText(app.prefs.overrideOrigin ?: "")
            setSingleLine()
        }
        val box = LinearLayout(this).apply {
            val p = Ui.dp(this@AdminActivity, 24f).toInt()
            setPadding(p, p / 2, p, 0)
            addView(field, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        AlertDialog.Builder(this)
            .setTitle("Board URL override")
            .setMessage("Tried before the built-in addresses. Must be http(s)://host[:port]; plain http only to 172.24.1.1 or 192.168.5.1.")
            .setView(box)
            .setPositiveButton(R.string.ok) { _, _ ->
                val raw = field.text.toString().trim()
                if (raw.isEmpty()) {
                    app.prefs.overrideOrigin = null
                } else {
                    val norm = OriginPolicy.normalizeOverride(raw)
                    if (norm == null) {
                        Toast.makeText(this, "Not a valid board address", Toast.LENGTH_LONG).show()
                        return@setPositiveButton
                    }
                    app.prefs.overrideOrigin = norm
                }
                setResult(RESULT_RELOAD)
                render()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun becomeHome() {
        Kiosk.setHomeAliasEnabled(this, true)
        if (Build.VERSION.SDK_INT >= 29) {
            val rm = getSystemService(RoleManager::class.java)
            if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_HOME) && !rm.isRoleHeld(RoleManager.ROLE_HOME)) {
                if (Kiosk.suspendFor(this) { roleLauncher.launch(rm.createRequestRoleIntent(RoleManager.ROLE_HOME)) }) return
            }
        }
        Kiosk.suspendFor(this) { startActivity(Intent(Settings.ACTION_HOME_SETTINGS)) }
    }

    private fun confirmRemoveOwner() {
        AlertDialog.Builder(this)
            .setTitle("Remove device owner?")
            .setMessage("The kiosk becomes normal screen pinning. Making the app device owner again needs a factory reset and adb.")
            .setPositiveButton("Remove") { _, _ ->
                Kiosk.clearDeviceOwner(this)
                render()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
}
