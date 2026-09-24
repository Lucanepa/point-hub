package ch.kscw.pointhub.update

import ch.kscw.pointhub.web.OriginPolicy
import org.json.JSONObject
import org.json.JSONTokener

/** The board's `/app/version.json`, validated. [apkUrl] is absolute and on the board origin. */
data class AppVersion(
    val versionCode: Int,
    val versionName: String,
    val sha256: String,
    val apkUrl: String,
    val notes: String,
    val size: Long?,
) {
    companion object {
        private val HEX64 = Regex("^[0-9a-f]{64}$")

        /** Returns null for anything malformed or pointing off the board. */
        fun parse(json: String, boardOrigin: String): AppVersion? {
            val origin = OriginPolicy.originOf(boardOrigin) ?: return null
            val o = try {
                JSONTokener(json).nextValue() as? JSONObject
            } catch (_: Exception) {
                null
            } ?: return null
            val code = o.opt("versionCode")
            val versionCode = when (code) {
                is Int -> code
                is Long -> if (code in 1..Int.MAX_VALUE) code.toInt() else return null
                else -> return null
            }
            if (versionCode <= 0) return null
            val sha = (o.opt("sha256") as? String)?.trim()?.lowercase() ?: return null
            if (!HEX64.matches(sha)) return null
            val url = (o.opt("url") as? String)?.trim() ?: return null
            val apkUrl = resolveApkUrl(url, origin) ?: return null
            val name = (o.opt("versionName") as? String)?.take(40) ?: versionCode.toString()
            val notes = (o.opt("notes") as? String)?.take(2000) ?: ""
            val size = (o.opt("size") as? Number)?.toLong()?.takeIf { it > 0 }
            return AppVersion(versionCode, name, sha, apkUrl, notes, size)
        }

        /** A relative `/app/...` path, or an absolute URL on exactly [origin]. */
        fun resolveApkUrl(url: String, origin: String): String? {
            if (url.startsWith("/app/") && !url.contains("..") && !url.contains("//") && !url.contains('\\')) {
                return origin + url
            }
            val o = OriginPolicy.originOf(url) ?: return null
            return if (o == origin) url else null
        }

        fun isNewer(remote: AppVersion, installedVersionCode: Long): Boolean = remote.versionCode > installedVersionCode
    }
}
