package ch.kscw.pointhub.net

import kotlinx.coroutines.delay
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateExpiredException
import javax.net.ssl.SSLHandshakeException

class BoardProberTest {
    private val https = "https://ledbox-c0270.noodlefish-pence.ts.net:8891"
    private val ap = "http://172.24.1.1:8890"
    private val cable = "http://192.168.5.1:8890"
    private val all = listOf(https, ap, cable)
    private val budgets = mapOf(https to 2500L, ap to 3500L, cable to 3500L)

    /** Each origin answers [result] after [delayMs] of virtual time. */
    private fun fake(vararg spec: Pair<String, Pair<Long, ProbeResult>>): suspend (String) -> ProbeResult {
        val m = spec.toMap()
        return { origin ->
            val (d, r) = m[origin] ?: (10_000L to ProbeResult.Fail(FailReason.TIMEOUT))
            delay(d)
            r
        }
    }

    private val ok = ProbeResult.Ok
    private fun fail(r: FailReason) = ProbeResult.Fail(r)

    @Test fun httpsWins() = runTest {
        val r = BoardProber.pick(all, { budgets.getValue(it) }, fake(https to (100L to ok), ap to (10L to ok), cable to (10L to ok)))
        assertEquals(PickResult.Found(https), r)
    }

    @Test fun httpsTimeoutFallsBackToAp() = runTest {
        val r = BoardProber.pick(all, { budgets.getValue(it) }, fake(https to (60_000L to ok), ap to (20L to ok)))
        assertEquals(PickResult.Found(ap), r)
        assertEquals(2500L, currentTime) // waited exactly https's budget, no longer
    }

    @Test fun tlsDateErrorFallsBackAndIsReported() = runTest {
        val r = BoardProber.pick(all, { budgets.getValue(it) }, fake(https to (50L to fail(FailReason.TLS_DATE)), ap to (5_000L to fail(FailReason.TIMEOUT)), cable to (5_000L to fail(FailReason.TIMEOUT))))
        r as PickResult.NotFound
        assertEquals(FailReason.TLS_DATE, r.failures[0].second.reason)

        val r2 = BoardProber.pick(all, { budgets.getValue(it) }, fake(https to (50L to fail(FailReason.TLS_DATE)), ap to (80L to ok)))
        assertEquals(PickResult.Found(ap), r2)
    }

    @Test fun onlyCable() = runTest {
        val r = BoardProber.pick(all, { budgets.getValue(it) }, fake(
            https to (10L to fail(FailReason.DNS)), ap to (10L to fail(FailReason.CONNECT)), cable to (30L to ok)))
        assertEquals(PickResult.Found(cable), r)
        assertEquals(30L, currentTime)
    }

    @Test fun nothingAnswers() = runTest {
        val r = BoardProber.pick(all, { budgets.getValue(it) }, fake(
            https to (10L to fail(FailReason.DNS)), ap to (10L to fail(FailReason.CONNECT)), cable to (99_000L to ok)))
        r as PickResult.NotFound
        assertEquals(listOf(https, ap, cable), r.failures.map { it.first })
        assertEquals(listOf(FailReason.DNS, FailReason.CONNECT, FailReason.TIMEOUT), r.failures.map { it.second.reason })
        assertEquals(3500L, currentTime)
    }

    @Test fun fastLowerPriorityWaitsForSlowerHigherPriority() = runTest {
        val r = BoardProber.pick(all, { budgets.getValue(it) }, fake(https to (2_000L to ok), ap to (10L to ok)))
        assertEquals(PickResult.Found(https), r)
        assertEquals(2_000L, currentTime)
    }

    @Test fun judgeRequiresJsonObject200() {
        val isObj: (String) -> Boolean = { it.trim().startsWith("{") }
        assertEquals(ProbeResult.Ok, BoardProber.judge(200, "{\"a\":1}", isObj))
        assertEquals(FailReason.NOT_JSON, (BoardProber.judge(200, "<html>", isObj) as ProbeResult.Fail).reason)
        assertEquals(FailReason.NOT_JSON, (BoardProber.judge(200, null, isObj) as ProbeResult.Fail).reason)
        assertEquals(FailReason.HTTP_STATUS, (BoardProber.judge(302, "{}", isObj) as ProbeResult.Fail).reason)
        assertEquals(FailReason.HTTP_STATUS, (BoardProber.judge(404, "{}", isObj) as ProbeResult.Fail).reason)
    }

    @Test fun errorClassification() {
        assertEquals(FailReason.DNS, ProbeErrors.classify(UnknownHostException("x")))
        assertEquals(FailReason.TIMEOUT, ProbeErrors.classify(SocketTimeoutException()))
        assertEquals(FailReason.CONNECT, ProbeErrors.classify(ConnectException()))
        assertEquals(FailReason.TLS_DATE, ProbeErrors.classify(SSLHandshakeException("x").apply { initCause(CertificateExpiredException()) }))
        assertEquals(FailReason.TLS_DATE, ProbeErrors.classify(SSLHandshakeException("Chain validation failed: certificate expired on 2025")))
        assertEquals(FailReason.TLS_OTHER, ProbeErrors.classify(SSLHandshakeException("Trust anchor not found")))
        assertTrue(ProbeErrors.classify(IllegalStateException()) == FailReason.OTHER)
    }
}
