package ch.kscw.pointhub.net

import android.net.Network
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import org.json.JSONTokener
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.coroutines.resume

/**
 * GET <origin>/api/status through a specific [Network] (or the process default when null).
 *
 * HttpURLConnection blocks and ignores thread interrupts, so the request runs on a pool thread and
 * cancellation (the prober's budget running out) disconnects the socket instead of waiting for it.
 */
object HttpProbe {
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "board-probe").apply { isDaemon = true } }

    fun open(url: URL, network: Network?): HttpURLConnection =
        (network?.openConnection(url) ?: url.openConnection()) as HttpURLConnection

    suspend fun probe(origin: String, network: Network?, t: BoardEndpoints.Timeouts = BoardEndpoints.timeoutsFor(origin)): ProbeResult =
        suspendCancellableCoroutine { cont ->
            var conn: HttpURLConnection? = null
            val future = pool.submit {
                val result = try {
                    val c = open(URL("$origin/api/status"), network)
                    conn = c
                    c.instanceFollowRedirects = false
                    c.connectTimeout = t.connectMs
                    c.readTimeout = t.readMs
                    c.useCaches = false
                    c.setRequestProperty("Cache-Control", "no-cache")
                    c.setRequestProperty("Accept", "application/json")
                    val status = c.responseCode
                    val body = if (status == 200) readCapped(c.inputStream, 256 * 1024) else null
                    BoardProber.judge(status, body, ::isJsonObject)
                } catch (e: Exception) {
                    ProbeResult.Fail(ProbeErrors.classify(e), e.javaClass.simpleName + ": " + e.message)
                } finally {
                    conn?.disconnect()
                }
                if (cont.isActive) cont.resume(result)
            }
            cont.invokeOnCancellation {
                future.cancel(true)
                try { conn?.disconnect() } catch (_: Exception) {}
            }
        }

    fun readCapped(input: InputStream, cap: Int): String? = input.use { s ->
        val buf = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        while (true) {
            val n = s.read(chunk)
            if (n < 0) break
            buf.write(chunk, 0, n)
            if (buf.size() > cap) return null
        }
        buf.toString(Charsets.UTF_8.name())
    }

    fun isJsonObject(body: String): Boolean = try {
        JSONTokener(body).nextValue() is JSONObject
    } catch (_: Exception) {
        false
    }
}
