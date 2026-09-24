package ch.kscw.pointhub.web

import java.net.URI
import java.util.Locale

/**
 * PURE. Which origins count as "the board", and how a URL is reduced to its origin.
 *
 * An origin here is the canonical string `scheme://host[:port]`: scheme and host lower-cased,
 * default ports (80 for http, 443 for https) dropped, no path, no userinfo. Two URLs are the same
 * origin exactly when their canonical strings are equal, so every check is a string compare on a
 * value this object produced itself, never on what the page handed us.
 */
object OriginPolicy {
    const val HTTPS_ORIGIN = "https://ledbox-c0270.noodlefish-pence.ts.net:8891"
    const val AP_ORIGIN = "http://172.24.1.1:8890"
    const val CABLE_ORIGIN = "http://192.168.5.1:8890"

    /** In priority order. */
    val BUILT_IN: List<String> = listOf(HTTPS_ORIGIN, AP_ORIGIN, CABLE_ORIGIN)

    /** The only hosts the network security config lets us reach over cleartext http. */
    val CLEARTEXT_HOSTS: Set<String> = setOf("172.24.1.1", "192.168.5.1")

    /**
     * The canonical origin of an absolute http(s) URL, or null for anything else (null, blank,
     * about:, data:, file:, javascript:, URLs with userinfo, URLs without a host).
     */
    fun originOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val uri = try {
            URI(url.trim())
        } catch (_: Exception) {
            return null
        }
        return canonical(uri)
    }

    private fun canonical(uri: URI): String? {
        if (uri.isOpaque) return null
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
        if (scheme != "http" && scheme != "https") return null
        // "http://172.24.1.1:8890@evil" parses as userinfo "172.24.1.1:8890", host "evil".
        if (uri.rawUserInfo != null) return null
        // URI.getHost() is null for registry-based authorities (e.g. underscores); refuse those.
        val host = uri.host?.lowercase(Locale.ROOT)?.trimEnd('.') ?: return null
        if (host.isEmpty()) return null
        val port = uri.port
        val defaultPort = if (scheme == "https") 443 else 80
        return if (port == -1 || port == defaultPort) "$scheme://$host" else "$scheme://$host:$port"
    }

    /**
     * Validates and canonicalises an admin-entered override. It must be `http(s)://host[:port]`,
     * optionally with a single trailing slash, and nothing else: no path, query, fragment or
     * userinfo. An http override must still target one of the two cleartext board IPs, because the
     * network security config refuses cleartext anywhere else. Returns null when invalid.
     */
    fun normalizeOverride(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val uri = try {
            URI(raw.trim())
        } catch (_: Exception) {
            return null
        }
        if (uri.isOpaque) return null
        val path = uri.rawPath ?: ""
        if (path.isNotEmpty() && path != "/") return null
        if (uri.rawQuery != null || uri.rawFragment != null) return null
        val origin = canonical(uri) ?: return null
        if (origin.startsWith("http://")) {
            val host = URI(origin).host
            if (host !in CLEARTEXT_HOSTS) return null
        }
        return origin
    }

    /** The allow-list in force: the built-in board origins plus the (valid) override, if any. */
    class Allowlist(override: String?) {
        val override: String? = normalizeOverride(override)
        val origins: Set<String> = (listOfNotNull(this.override) + BUILT_IN).toSet()

        /** True when [url] is an absolute http(s) URL on exactly one of the board origins. */
        fun isAllowed(url: String?): Boolean {
            val origin = originOf(url) ?: return false
            return origin in origins
        }

        /** True for URLs the WebView may load even though they are not a board origin. */
        fun isInertLocal(url: String?): Boolean {
            if (url == null) return false
            val u = url.trim().lowercase(Locale.ROOT)
            return u == "about:blank" || u.startsWith("data:")
        }
    }
}
