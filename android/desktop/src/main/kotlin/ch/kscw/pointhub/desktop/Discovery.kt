package ch.kscw.pointhub.desktop

import ch.kscw.pointhub.web.OriginPolicy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.json.JSONTokener
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * Finds the board, as the tablet does but without binding a network: the address typed in
 * Settings, then the board's https name (its tailnet name; its own Wi-Fi resolves it too), then its
 * Wi-Fi (172.24.1.1) and the cable (192.168.5.1). All are asked at once; the first in that order
 * that answers GET /api/status with a JSON object wins.
 */
object Discovery {
    data class Probe(val origin: String, val ok: Boolean, val why: String)

    fun candidates(override: String?): List<String> =
        (listOfNotNull(OriginPolicy.normalizeOverride(override)) + OriginPolicy.BUILT_IN).distinct()

    suspend fun find(override: String?): Pair<String?, List<Probe>> = coroutineScope {
        val probes = candidates(override).map { o -> async { probe(o) } }.awaitAll()
        probes.firstOrNull { it.ok }?.origin to probes
    }

    suspend fun probe(origin: String): Probe = withContext(Dispatchers.IO) {
        var c: HttpURLConnection? = null
        try {
            c = (URL("$origin/api/status").openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = if (origin.startsWith("https")) 2500 else 1500
                readTimeout = 2500
                useCaches = false
                setRequestProperty("Accept", "application/json")
            }
            val status = c.responseCode
            if (status != 200) return@withContext Probe(origin, false, "HTTP $status")
            val body = c.inputStream.use { it.readNBytes(256 * 1024) }.toString(Charsets.UTF_8)
            val ok = try { JSONTokener(body).nextValue() is JSONObject } catch (_: Exception) { false }
            Probe(origin, ok, if (ok) "ok" else "not the scoreboard")
        } catch (_: UnknownHostException) {
            Probe(origin, false, "name not found")
        } catch (_: SocketTimeoutException) {
            Probe(origin, false, "no answer")
        } catch (e: SSLException) {
            Probe(origin, false, "certificate" + if ((e.message ?: "").contains("valid", true)) " (computer clock?)" else "")
        } catch (e: Exception) {
            Probe(origin, false, "not reachable")
        } finally {
            c?.disconnect()
        }
    }

    fun label(origin: String) = when (origin) {
        OriginPolicy.HTTPS_ORIGIN -> "https"
        OriginPolicy.AP_ORIGIN -> "172.24.1.1"
        OriginPolicy.CABLE_ORIGIN -> "cable"
        else -> origin
    }
}
