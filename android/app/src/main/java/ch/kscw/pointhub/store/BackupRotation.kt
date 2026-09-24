package ch.kscw.pointhub.store

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** One backup file as the rotation sees it. [savedAt] is epoch millis. */
data class BackupEntry(val name: String, val bytes: Long, val savedAt: Long)

/** PURE. Which backups to delete so at most [maxFiles] files and [maxBytes] bytes remain. */
object BackupRotation {
    const val MAX_FILES = 50
    const val MAX_BYTES = 20L * 1024 * 1024

    /** Newest first; ties broken by name (the timestamp prefix), newest name first. */
    val NEWEST_FIRST: Comparator<BackupEntry> =
        compareByDescending<BackupEntry> { it.savedAt }.thenByDescending { it.name }

    fun toDelete(entries: List<BackupEntry>, maxFiles: Int = MAX_FILES, maxBytes: Long = MAX_BYTES): List<String> {
        val sorted = entries.sortedWith(NEWEST_FIRST)
        if (sorted.isEmpty()) return emptyList()
        var kept = 1 // the newest single file is always kept, whatever its size
        var bytes = sorted[0].bytes
        var i = 1
        while (i < sorted.size) {
            val e = sorted[i]
            if (kept >= maxFiles || bytes + e.bytes > maxBytes) break
            kept++
            bytes += e.bytes
            i++
        }
        return sorted.drop(i).map { it.name }
    }
}

/** PURE. File names for backups: `<yyyyMMdd'T'HHmmss.SSS'Z'>_<name>.json`, which sorts by time. */
object BackupNames {
    const val MAX_NAME = 80

    fun sanitize(name: String?): String {
        val cleaned = (name ?: "")
            .replace(Regex("[^A-Za-z0-9._-]+"), "-")
            .trim('-', '.', '_')
            .take(MAX_NAME)
            .trimEnd('-', '.')
        return cleaned.ifEmpty { "backup" }.removeSuffix(".json").ifEmpty { "backup" }
    }

    fun stamp(millis: Long): String = SimpleDateFormat("yyyyMMdd'T'HHmmss.SSS'Z'", Locale.ROOT)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(millis))

    fun iso(millis: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(millis))

    fun fileName(millis: Long, name: String?): String = "${stamp(millis)}_${sanitize(name)}.json"

    /** The save time encoded in a backup file name, or null. */
    fun parseStamp(fileName: String): Long? = try {
        SimpleDateFormat("yyyyMMdd'T'HHmmss.SSS'Z'", Locale.ROOT)
            .apply { timeZone = TimeZone.getTimeZone("UTC"); isLenient = false }
            .parse(fileName.substringBefore('_'))?.time
    } catch (_: Exception) {
        null
    }

    /** A name we produced ourselves (guards reads/deletes against anything else in the dir). */
    fun isBackupFile(fileName: String): Boolean =
        Regex("^\\d{8}T\\d{6}\\.\\d{3}Z_[A-Za-z0-9._-]+\\.json$").matches(fileName)
}
