package ch.kscw.pointhub.store

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.locks.ReentrantLock
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.concurrent.withLock

/** What the offline screen shows from the newest backup (every field optional). */
data class MatchSummary(
    val backupName: String,
    val savedAt: Long,
    val title: String? = null,
    val home: String? = null,
    val away: String? = null,
    val sets: String? = null,
    val score: String? = null,
    val state: String? = null,
    val at: String? = null,
)

object Json {
    /** True when [text] is exactly one JSON object or array (no trailing garbage). */
    fun isObjectOrArray(text: String): Boolean = parseTop(text).let { it is JSONObject || it is JSONArray }

    fun parseTop(text: String): Any? = try {
        val t = JSONTokener(text)
        val v = t.nextValue()
        if (t.nextClean() != 0.toChar()) null else v
    } catch (_: Exception) {
        null
    }
}

/** Writes [bytes] to [target] atomically: temp file, fsync, rename. */
internal fun atomicWrite(target: File, bytes: ByteArray) {
    target.parentFile?.mkdirs()
    val tmp = File(target.parentFile, target.name + ".tmp")
    FileOutputStream(tmp).use { out ->
        out.write(bytes)
        out.flush()
        out.fd.sync()
    }
    if (!tmp.renameTo(target)) {
        tmp.delete()
        throw IOException("rename failed: ${target.name}")
    }
}

/**
 * The tablet's own copy of the console's backups: `files/backups/`, rotated to at most
 * [maxFiles] files and [maxBytes] bytes. java.io only, so it is tested on the JVM.
 */
class BackupStore(
    private val dir: File,
    private val clock: () -> Long = System::currentTimeMillis,
    private val maxFiles: Int = BackupRotation.MAX_FILES,
    private val maxBytes: Long = BackupRotation.MAX_BYTES,
) {
    val lock = ReentrantLock()

    companion object {
        const val MAX_JSON_CHARS = 5 * 1024 * 1024
    }

    /** Returns the saved file name, or null if the input was rejected. Throws on I/O failure. */
    fun save(name: String?, json: String): String? {
        if (json.length > MAX_JSON_CHARS) return null
        if (name != null && name.length > BackupNames.MAX_NAME) return null
        if (!Json.isObjectOrArray(json)) return null
        val bytes = json.toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_JSON_CHARS) return null
        return lock.withLock {
            dir.mkdirs()
            // Two saves in the same millisecond: bump the stamp, so names stay unique AND in time order.
            var now = clock()
            while (File(dir, BackupNames.fileName(now, name)).exists()) now++
            val fileName = BackupNames.fileName(now, name)
            val target = File(dir, fileName)
            atomicWrite(target, bytes)
            target.setLastModified(now)
            rotateLocked()
            fileName
        }
    }

    private fun entriesLocked(): List<BackupEntry> =
        (dir.listFiles() ?: emptyArray())
            .filter { it.isFile && BackupNames.isBackupFile(it.name) }
            // savedAt comes from the name (ms precision, immune to coarse mtimes); mtime is the fallback.
            .map { BackupEntry(it.name, it.length(), BackupNames.parseStamp(it.name) ?: it.lastModified()) }

    private fun rotateLocked() {
        for (name in BackupRotation.toDelete(entriesLocked(), maxFiles, maxBytes)) File(dir, name).delete()
    }

    /** Newest first. */
    fun list(): List<BackupEntry> = lock.withLock { entriesLocked().sortedWith(BackupRotation.NEWEST_FIRST) }

    fun listJson(): String {
        val arr = JSONArray()
        for (e in list()) {
            arr.put(JSONObject().put("name", e.name).put("bytes", e.bytes).put("savedAt", BackupNames.iso(e.savedAt)))
        }
        return arr.toString()
    }

    /** The `summary` object of the newest backup that has one readable (see BRIDGE.md). */
    fun newestSummary(): MatchSummary? {
        val newest = list().firstOrNull() ?: return null
        val text = try {
            lock.withLock { File(dir, newest.name).readText(Charsets.UTF_8) }
        } catch (_: IOException) {
            return null
        }
        val s = (Json.parseTop(text) as? JSONObject)?.optJSONObject("summary")
        fun f(k: String): String? = s?.opt(k)?.takeIf { it is String && it.isNotBlank() } as String?
        return MatchSummary(newest.name, newest.savedAt, f("title"), f("home"), f("away"), f("sets"), f("score"), f("state"), f("at"))
    }

    /**
     * Zips every backup plus [extras] (e.g. schedule.json, manifest.json) into [out].
     * Returns the number of backup files written. Does not close [out].
     */
    fun writeZip(out: OutputStream, extras: Map<String, ByteArray>): Int = lock.withLock {
        val entries = entriesLocked().sortedWith(BackupRotation.NEWEST_FIRST)
        val zip = ZipOutputStream(out)
        for (e in entries) {
            val f = File(dir, e.name)
            val ze = ZipEntry("backups/${e.name}")
            ze.time = e.savedAt
            zip.putNextEntry(ze)
            f.inputStream().use { it.copyTo(zip) }
            zip.closeEntry()
        }
        for ((name, bytes) in extras) {
            zip.putNextEntry(ZipEntry(name))
            zip.write(bytes)
            zip.closeEntry()
        }
        zip.finish()
        zip.flush()
        entries.size
    }
}

/** The offline copy of the season schedule: one file, `files/schedule.json`. */
class ScheduleStore(private val file: File) {
    companion object {
        const val MAX_JSON_CHARS = 2 * 1024 * 1024
    }

    private val lock = ReentrantLock()

    fun save(json: String): Boolean {
        if (json.length > MAX_JSON_CHARS) return false
        if (!Json.isObjectOrArray(json)) return false
        val bytes = json.toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_JSON_CHARS) return false
        lock.withLock { atomicWrite(file, bytes) }
        return true
    }

    fun load(): String? = lock.withLock {
        if (!file.isFile) null else try {
            file.readText(Charsets.UTF_8)
        } catch (_: IOException) {
            null
        }
    }

    fun bytesOrNull(): ByteArray? = lock.withLock { if (file.isFile) file.readBytes() else null }
}
