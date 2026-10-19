package ch.kscw.pointhub.desktop

import org.json.JSONObject
import java.io.File

/**
 * The desktop app's settings, one small JSON file (settings.json in Paths.config). Written whole on
 * every change, through a temp file, so a crash never leaves half a file.
 */
class DesktopPrefs(private val file: File = File(Paths.config, "settings.json")) {
    private val json: JSONObject = try {
        if (file.isFile) JSONObject(file.readText()) else JSONObject()
    } catch (_: Exception) {
        JSONObject()
    }

    @Synchronized
    private fun save() {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(json.toString(2))
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    }

    @Synchronized
    private fun put(key: String, v: Any?) {
        if (v == null) json.remove(key) else json.put(key, v)
        save()
    }

    /** The board's address typed in Settings (http(s)://host[:port]); null = find it. */
    var overrideOrigin: String?
        get() = json.optString("overrideOrigin").ifEmpty { null }
        set(v) = put("overrideOrigin", v)

    var scorerPin: String
        get() = json.optString("scorerPin")
        set(v) = put("scorerPin", v.ifEmpty { null })

    var endAskedSig: String?
        get() = json.optString("endAskedSig").ifEmpty { null }
        set(v) = put("endAskedSig", v)

    /** light | dark | eink, as the console last reported it. */
    var theme: String
        get() = json.optString("theme").ifEmpty { "light" }
        set(v) = put("theme", v)

    /** Draw the Game tab natively (true) or show the whole web console. */
    var nativeGame: Boolean
        get() = json.optBoolean("nativeGame", true)
        set(v) = put("nativeGame", v)

    /** The last board that answered, tried first next time. */
    var lastOrigin: String?
        get() = json.optString("lastOrigin").ifEmpty { null }
        set(v) = put("lastOrigin", v)
}
