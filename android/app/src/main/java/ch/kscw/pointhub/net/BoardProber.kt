package ch.kscw.pointhub.net

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.UnknownServiceException
import java.security.cert.CertificateExpiredException
import java.security.cert.CertificateNotYetValidException
import javax.net.ssl.SSLException

/** Why a probe failed. Shown (in plain words) on the offline screen. */
enum class FailReason { DNS, CONNECT, TIMEOUT, TLS_DATE, TLS_OTHER, HTTP_STATUS, NOT_JSON, CLEARTEXT_BLOCKED, NO_NETWORK, OTHER }

sealed class ProbeResult {
    data object Ok : ProbeResult()
    data class Fail(val reason: FailReason, val detail: String? = null) : ProbeResult()
}

sealed class PickResult {
    data class Found(val origin: String) : PickResult()
    /** One entry per candidate, in priority order. */
    data class NotFound(val failures: List<Pair<String, ProbeResult.Fail>>) : PickResult()
}

/** PURE. Maps what HttpURLConnection threw to a [FailReason]. */
object ProbeErrors {
    fun classify(t: Throwable): FailReason {
        var c: Throwable? = t
        var sawSsl = false
        val seen = HashSet<Throwable>()
        while (c != null && seen.add(c)) {
            when (c) {
                is CertificateExpiredException, is CertificateNotYetValidException -> return FailReason.TLS_DATE
                is SSLException -> sawSsl = true
            }
            c = c.cause
        }
        if (sawSsl) {
            // Conscrypt wraps the date failure as a message rather than a typed cause on some builds.
            val msg = generateSequence(t) { it.cause }.mapNotNull { it.message }.joinToString(" ").lowercase()
            if ("expired" in msg || "not yet valid" in msg || "notbefore" in msg || "notafter" in msg) return FailReason.TLS_DATE
            return FailReason.TLS_OTHER
        }
        return when (t) {
            is UnknownHostException -> FailReason.DNS
            is SocketTimeoutException -> FailReason.TIMEOUT
            is ConnectException, is NoRouteToHostException -> FailReason.CONNECT
            is UnknownServiceException -> FailReason.CLEARTEXT_BLOCKED
            is InterruptedIOException -> FailReason.TIMEOUT
            else -> FailReason.OTHER
        }
    }
}

/**
 * PURE (given an injected probe function). Probes every candidate concurrently and returns the
 * HIGHEST-PRIORITY one that answered: a fast answer from the AP IP does not beat https while https
 * is still within its budget, but https never delays the answer by more than its own budget.
 */
object BoardProber {
    suspend fun pick(
        candidates: List<String>,
        budgetMs: (String) -> Long = { BoardEndpoints.timeoutsFor(it).totalMs },
        probe: suspend (String) -> ProbeResult,
    ): PickResult = coroutineScope {
        val jobs = candidates.map { origin ->
            origin to async {
                withTimeoutOrNull(budgetMs(origin)) { probe(origin) }
                    ?: ProbeResult.Fail(FailReason.TIMEOUT)
            }
        }
        val failures = ArrayList<Pair<String, ProbeResult.Fail>>()
        for ((origin, job) in jobs) {
            when (val r = job.await()) {
                ProbeResult.Ok -> {
                    jobs.forEach { it.second.cancel() }
                    return@coroutineScope PickResult.Found(origin)
                }
                is ProbeResult.Fail -> failures += origin to r
            }
        }
        PickResult.NotFound(failures)
    }

    /**
     * PURE. What counts as "the board answered": HTTP 200 and a body that is a JSON object.
     * Redirects are not followed, so a 3xx is a failure too.
     */
    fun judge(status: Int, body: String?, isJsonObject: (String) -> Boolean): ProbeResult = when {
        status != 200 -> ProbeResult.Fail(FailReason.HTTP_STATUS, "HTTP $status")
        body == null || !isJsonObject(body) -> ProbeResult.Fail(FailReason.NOT_JSON)
        else -> ProbeResult.Ok
    }
}
