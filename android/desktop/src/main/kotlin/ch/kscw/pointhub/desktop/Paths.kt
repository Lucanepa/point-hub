package ch.kscw.pointhub.desktop

import java.io.File

/**
 * Where the desktop app keeps its things, per OS: XDG on Linux (which Flatpak points into the
 * sandbox), %APPDATA% on Windows, Application Support on macOS.
 */
object Paths {
    private val os = System.getProperty("os.name").lowercase()
    private val home = File(System.getProperty("user.home"))

    val config: File by lazy {
        when {
            os.contains("win") -> File(System.getenv("APPDATA") ?: "$home/AppData/Roaming", "Point Hub")
            os.contains("mac") -> File(home, "Library/Application Support/Point Hub")
            else -> File(System.getenv("XDG_CONFIG_HOME")?.takeIf { it.isNotBlank() } ?: "$home/.config", "point-hub")
        }.also { it.mkdirs() }
    }

    val data: File by lazy {
        when {
            os.contains("win") -> File(System.getenv("LOCALAPPDATA") ?: "$home/AppData/Local", "Point Hub")
            os.contains("mac") -> File(home, "Library/Application Support/Point Hub")
            else -> File(System.getenv("XDG_DATA_HOME")?.takeIf { it.isNotBlank() } ?: "$home/.local/share", "point-hub")
        }.also { it.mkdirs() }
    }

    val cefCache: File get() = File(data, "browser").also { it.mkdirs() }
}
