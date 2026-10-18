package ch.kscw.pointhub.game

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.json.JSONTokener
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The board's control API, as the console calls it (`api()` / `postJSON()` in web/index.html).
 *
 * Every request has a deadline, as in the console: a link that blackholes rather than resets
 * (a Wi-Fi roam, a wedged socket) must not leave a +1 hanging and then land late on top of the
 * next one. Reads get 4 s, writes 8 s, and the writes that change the panel LAYOUT 25 s: those
 * wait for the board to walk its idle screens, and giving up at 8 s only made the scorer re-tap
 * something that had worked.
 *
 * Writes carry the scorer PIN in `X-Scorer-Pin` and `Content-Type: application/json`. No Origin
 * header: the board's cross-origin check lets a request without one through (it is not a browser).
 */
class BoardApi(
    private val origin: () -> String?,
    private val open: (URL) -> HttpURLConnection,
    private val pin: () -> String,
) {
    /** The board answered with a refusal (4xx/5xx). [message] is the board's own words when it sent some. */
    class Refused(val status: Int, message: String, val body: JSONObject?) : Exception(message)

    /** No answer: unreachable, timed out, or not a board. The console's "board unreachable". */
    class Unreachable(message: String, cause: Throwable? = null) : Exception(message, cause)

    companion object {
        const val READ_MS = 4_000
        const val WRITE_MS = 8_000
        const val LAYOUT_MS = 25_000
        /** A board searching its Wi-Fi for a scorer laptop answers /api/matches late on purpose. */
        const val SLOW_READ_MS = 20_000
        private val LAYOUT_PATHS = setOf("/api/idle", "/api/game", "/api/link")
        private const val MAX_BODY = 4 * 1024 * 1024

        private val pool = Executors.newCachedThreadPool { r -> Thread(r, "board-api").apply { isDaemon = true } }
    }

    private fun readCapped(input: java.io.InputStream, cap: Int): String? = input.use { s ->
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

    suspend fun get(path: String, timeoutMs: Int = READ_MS): JSONObject = request("GET", path, null, timeoutMs)

    suspend fun post(path: String, body: JSONObject = JSONObject(), timeoutMs: Int? = null): JSONObject =
        request("POST", path, body, timeoutMs ?: if (path in LAYOUT_PATHS) LAYOUT_MS else WRITE_MS)

    private suspend fun request(method: String, path: String, body: JSONObject?, timeoutMs: Int): JSONObject {
        val base = origin() ?: throw Unreachable("The scoreboard has not been found yet.")
        val pinNow = pin()
        return withContext(Dispatchers.IO) {
            suspendCancellableCoroutine { cont ->
                var conn: HttpURLConnection? = null
                val future = pool.submit {
                    try {
                        val c = open(URL(base + path))
                        conn = c
                        c.instanceFollowRedirects = false
                        c.connectTimeout = minOf(timeoutMs, 4_000)
                        c.readTimeout = timeoutMs
                        c.useCaches = false
                        c.requestMethod = method
                        c.setRequestProperty("Accept", "application/json")
                        c.setRequestProperty("Cache-Control", "no-cache")
                        if (body != null) {
                            val bytes = body.toString().toByteArray(Charsets.UTF_8)
                            c.doOutput = true
                            c.setRequestProperty("Content-Type", "application/json")
                            c.setRequestProperty("X-Scorer-Pin", pinNow)
                            c.setFixedLengthStreamingMode(bytes.size)
                            c.outputStream.use { it.write(bytes) }
                        }
                        val status = c.responseCode
                        val stream = if (status >= 400) c.errorStream else c.inputStream
                        val text = stream?.let { readCapped(it, MAX_BODY) }
                        val json = text?.let { t ->
                            try { JSONTokener(t).nextValue() as? JSONObject } catch (_: Exception) { null }
                        }
                        if (status !in 200..299) {
                            val msg = json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "$path → $status"
                            if (cont.isActive) cont.resumeWithException(Refused(status, msg, json))
                        } else {
                            if (cont.isActive) cont.resume(json ?: JSONObject())
                        }
                    } catch (e: SocketTimeoutException) {
                        if (cont.isActive) cont.resumeWithException(Unreachable("The board didn't answer in time — try again.", e))
                    } catch (e: Exception) {
                        if (cont.isActive) cont.resumeWithException(Unreachable(e.message ?: e.javaClass.simpleName, e))
                    } finally {
                        conn?.disconnect()
                    }
                }
                cont.invokeOnCancellation {
                    future.cancel(true)
                    try { conn?.disconnect() } catch (_: Exception) {}
                }
            }
        }
    }
}
