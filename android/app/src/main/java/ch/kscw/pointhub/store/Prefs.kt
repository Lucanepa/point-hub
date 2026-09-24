package ch.kscw.pointhub.store

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/** Plain (non-secret) settings. The Wi-Fi passphrase is in [SecretStore], never here. */
class Prefs(context: Context) : PinStorage {
    private val sp: SharedPreferences = context.getSharedPreferences("pointhub", Context.MODE_PRIVATE)

    companion object {
        const val DEFAULT_SSID = "ledbox_C0270"
    }

    var setupDone: Boolean
        get() = sp.getBoolean("setupDone", false)
        set(v) = sp.edit { putBoolean("setupDone", v) }

    var ssid: String
        get() = sp.getString("ssid", null) ?: DEFAULT_SSID
        set(v) = sp.edit { putString("ssid", v) }

    /** Whether Wi-Fi was configured at setup (false = "cable / Tailscale only"). */
    var wifiConfigured: Boolean
        get() = sp.getBoolean("wifiConfigured", false)
        set(v) = sp.edit { putBoolean("wifiConfigured", v) }

    var overrideOrigin: String?
        get() = sp.getString("overrideOrigin", null)
        set(v) = sp.edit { if (v == null) remove("overrideOrigin") else putString("overrideOrigin", v) }

    var lastOrigin: String?
        get() = sp.getString("lastOrigin", null)
        set(v) = sp.edit { putString("lastOrigin", v) }

    var kioskPinning: Boolean
        get() = sp.getBoolean("kioskPinning", true)
        set(v) = sp.edit { putBoolean("kioskPinning", v) }

    var lastUpdateCheck: Long
        get() = sp.getLong("lastUpdateCheck", 0)
        set(v) = sp.edit { putLong("lastUpdateCheck", v) }

    /** The update banner was dismissed for this versionCode (survives restarts). */
    var dismissedUpdateCode: Int
        get() = sp.getInt("dismissedUpdateCode", -1)
        set(v) = sp.edit { putInt("dismissedUpdateCode", v) }

    /** Admin "Exit app": resume the kiosk (and re-take HOME if [restoreHomeOnStart]) on next start. */
    var exitedByAdmin: Boolean
        get() = sp.getBoolean("exitedByAdmin", false)
        set(v) = sp.edit(commit = true) { putBoolean("exitedByAdmin", v) }
    var restoreHomeOnStart: Boolean
        get() = sp.getBoolean("restoreHomeOnStart", false)
        set(v) = sp.edit(commit = true) { putBoolean("restoreHomeOnStart", v) }

    override var pinHash: String?
        get() = sp.getString("pinHash", null)
        set(v) = sp.edit(commit = true) { putString("pinHash", v) }
    override var pinSalt: String?
        get() = sp.getString("pinSalt", null)
        set(v) = sp.edit(commit = true) { putString("pinSalt", v) }
    override var pinFailures: Int
        get() = sp.getInt("pinFailures", 0)
        set(v) = sp.edit(commit = true) { putInt("pinFailures", v) }
    override var pinLockedUntil: Long
        get() = sp.getLong("pinLockedUntil", 0)
        set(v) = sp.edit(commit = true) { putLong("pinLockedUntil", v) }
}
