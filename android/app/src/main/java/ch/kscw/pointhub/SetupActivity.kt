package ch.kscw.pointhub

import android.content.Intent
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import ch.kscw.pointhub.kiosk.Kiosk
import ch.kscw.pointhub.net.hasWifiRequestPermission
import ch.kscw.pointhub.net.wifiRequestPermission
import ch.kscw.pointhub.store.AdminPin
import kotlin.concurrent.thread

/**
 * First run (Wi-Fi + admin PIN) and admin → "Wi-Fi setup" (Wi-Fi only). Saves the passphrase in
 * the Keystore-backed [ch.kscw.pointhub.store.SecretStore], adds a network suggestion, and offers
 * Android's "Save this network?" sheet so the AP becomes a normal saved network.
 */
class SetupActivity : ComponentActivity() {
    companion object {
        const val EXTRA_FIRST_RUN = "firstRun"
        private const val TAG = "SetupActivity"
    }

    private lateinit var app: PointHubApp
    private var firstRun = false
    private lateinit var ssid: EditText
    private lateinit var pass: EditText
    private lateinit var pin: EditText
    private lateinit var pin2: EditText
    private lateinit var error: TextView
    private lateinit var save: Button

    private lateinit var permissionLauncher: ActivityResultLauncher<String>
    private lateinit var addNetworkLauncher: ActivityResultLauncher<Intent>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app = pointHub
        firstRun = intent.getBooleanExtra(EXTRA_FIRST_RUN, false) || !app.prefs.setupDone
        setContentView(R.layout.activity_setup)
        ssid = findViewById(R.id.setupSsid)
        pass = findViewById(R.id.setupPass)
        pin = findViewById(R.id.setupPin)
        pin2 = findViewById(R.id.setupPin2)
        error = findViewById(R.id.setupError)
        save = findViewById(R.id.setupSave)

        ssid.setText(app.prefs.ssid)
        if (firstRun) {
            pin.setText(AdminPin.DEFAULT_PIN)
            pin2.setText(AdminPin.DEFAULT_PIN)
        } else {
            findViewById<View>(R.id.setupPinGroup).visibility = View.GONE
            if (app.prefs.wifiConfigured) pass.hint = "Wi-Fi password (leave empty to keep the saved one)"
        }
        findViewById<CheckBox>(R.id.setupShowPass).setOnCheckedChangeListener { _, show ->
            pass.inputType = InputType.TYPE_CLASS_TEXT or
                (if (show) InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD else InputType.TYPE_TEXT_VARIATION_PASSWORD)
            pass.setSelection(pass.text.length)
        }

        permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { addNetworks() }
        addNetworkLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            Log.i(TAG, "add-networks sheet result ${r.resultCode}")
            done()
        }

        save.setOnClickListener { onSave(skipWifi = false) }
        findViewById<Button>(R.id.setupSkip).setOnClickListener { onSave(skipWifi = true) }
    }

    private fun onSave(skipWifi: Boolean) {
        error.text = ""
        val s = ssid.text.toString().trim()
        val p = pass.text.toString()
        val keepPass = !firstRun && p.isEmpty() && app.prefs.wifiConfigured
        if (!skipWifi) {
            if (s.isEmpty() || s.toByteArray().size > 32) return fail("Enter the Wi-Fi name (up to 32 characters).")
            if (!keepPass && (p.length < 8 || p.length > 63)) return fail("The Wi-Fi password must be 8 to 63 characters.")
        }
        val newPin = pin.text.toString()
        if (firstRun) {
            if (!AdminPin.isValidFormat(newPin)) return fail("The admin PIN must be 4 to 8 digits.")
            if (newPin != pin2.text.toString()) return fail("The two PINs differ.")
        }
        save.isEnabled = false
        thread(name = "setup-save") {
            try {
                if (firstRun) app.adminPin.set(newPin)
                if (!skipWifi) {
                    app.prefs.ssid = s
                    if (!keepPass) app.secrets.setWifiPassphrase(p)
                    app.prefs.wifiConfigured = true
                } else if (firstRun) {
                    app.prefs.wifiConfigured = false
                }
                runOnUiThread { if (skipWifi) done() else requestPermissionThenAdd() }
            } catch (e: Exception) {
                Log.w(TAG, "save failed", e)
                runOnUiThread { save.isEnabled = true; fail("Could not save: ${e.message}") }
            }
        }
    }

    private fun fail(msg: String) {
        error.text = msg
    }

    /** NEARBY_WIFI_DEVICES (33+) lets the app ask Android to join the board AP later; not location. */
    private fun requestPermissionThenAdd() {
        val perm = wifiRequestPermission()
        if (perm != null && !hasWifiRequestPermission(this)) permissionLauncher.launch(perm) else addNetworks()
    }

    private fun addNetworks() {
        if (Build.VERSION.SDK_INT < 29) return done()
        val pass = app.secrets.wifiPassphrase() ?: return done()
        val suggestion = WifiNetworkSuggestion.Builder()
            .setSsid(app.prefs.ssid)
            .setWpa2Passphrase(pass)
            .apply {
                if (Build.VERSION.SDK_INT >= 30) {
                    setIsInitialAutojoinEnabled(true)
                    setIsMetered(false)
                }
            }
            .build()
        try {
            val wm = applicationContext.getSystemService(WifiManager::class.java)
            val status = wm.addNetworkSuggestions(listOf(suggestion))
            if (status != WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS &&
                status != WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_ADD_DUPLICATE
            ) Log.w(TAG, "addNetworkSuggestions status $status")
        } catch (e: Exception) {
            Log.w(TAG, "addNetworkSuggestions failed", e)
        }
        if (Build.VERSION.SDK_INT >= 30) {
            val sheet = Intent(Settings.ACTION_WIFI_ADD_NETWORKS)
                .putParcelableArrayListExtra(Settings.EXTRA_WIFI_NETWORK_LIST, arrayListOf(suggestion))
            if (!Kiosk.suspendFor(this) { addNetworkLauncher.launch(sheet) }) done()
        } else {
            done()
        }
    }

    private fun done() {
        val wasFirst = !app.prefs.setupDone
        app.prefs.setupDone = true
        if (wasFirst) {
            startActivity(Intent(this, MainActivity::class.java))
        } else {
            app.boardNetwork.rediscover()
        }
        finish()
    }
}
