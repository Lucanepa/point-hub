package ch.kscw.pointhub.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginPolicyTest {
    private val a = OriginPolicy.Allowlist(null)

    @Test fun exactBoardOriginsAllowed() {
        assertTrue(a.isAllowed("https://ledbox-c0270.noodlefish-pence.ts.net:8891/"))
        assertTrue(a.isAllowed("https://ledbox-c0270.noodlefish-pence.ts.net:8891/index.html?x=1#y"))
        assertTrue(a.isAllowed("http://172.24.1.1:8890/api/status"))
        assertTrue(a.isAllowed("http://192.168.5.1:8890"))
        assertTrue(a.isAllowed("HTTPS://LEDBOX-C0270.NOODLEFISH-PENCE.TS.NET:8891/"))
    }

    @Test fun lookalikesDenied() {
        listOf(
            "http://172.24.1.1:8891/",
            "https://172.24.1.1:8890/",
            "http://172.24.1.1/",
            "https://ledbox-c0270.noodlefish-pence.ts.net/",
            "https://ledbox-c0270.noodlefish-pence.ts.net:8891.evil.com/",
            "https://ledbox-c0270.noodlefish-pence.ts.net.evil.com:8891/",
            "http://172.24.1.1:8890@evil.example/",
            "http://user:pw@172.24.1.1:8890/",
            "http://evil.example/?u=http://172.24.1.1:8890",
            null, "", "about:blank", "file:///android_asset/x.html", "data:text/html,hi",
            "javascript:alert(1)", "blob:http://172.24.1.1:8890/abc", "ws://172.24.1.1:8890/",
        ).forEach { assertFalse("should deny $it", a.isAllowed(it)) }
    }

    @Test fun originCanonicalisation() {
        assertEquals("https://example.com", OriginPolicy.originOf("https://Example.COM:443/x"))
        assertEquals("http://172.24.1.1:8890", OriginPolicy.originOf("http://172.24.1.1:8890/a/b"))
        assertEquals("http://example.com", OriginPolicy.originOf("http://example.com:80"))
        assertNull(OriginPolicy.originOf("about:blank"))
    }

    @Test fun overrideAcceptedOnlyWhenWellFormed() {
        assertEquals("https://board.example:8443", OriginPolicy.normalizeOverride("https://BOARD.example:8443/"))
        assertEquals("http://172.24.1.1:9000", OriginPolicy.normalizeOverride(" http://172.24.1.1:9000 "))
        assertEquals("https://board.example", OriginPolicy.normalizeOverride("https://board.example:443"))
        assertNull(OriginPolicy.normalizeOverride("http://evil.example:8890"))
        assertNull(OriginPolicy.normalizeOverride("https://board.example/console"))
        assertNull(OriginPolicy.normalizeOverride("https://board.example/?q"))
        assertNull(OriginPolicy.normalizeOverride("https://u@board.example"))
        assertNull(OriginPolicy.normalizeOverride("ftp://board.example"))
        assertNull(OriginPolicy.normalizeOverride("board.example"))
        assertNull(OriginPolicy.normalizeOverride(""))
    }

    @Test fun overrideJoinsAllowlist() {
        val b = OriginPolicy.Allowlist("https://board.example:8443/")
        assertTrue(b.isAllowed("https://board.example:8443/x"))
        assertTrue(b.isAllowed("http://172.24.1.1:8890/"))
        assertFalse(b.isAllowed("https://board.example/"))
        val bad = OriginPolicy.Allowlist("http://evil.example")
        assertNull(bad.override)
        assertFalse(bad.isAllowed("http://evil.example/"))
    }

    @Test fun inertLocalUrls() {
        assertTrue(a.isInertLocal("about:blank"))
        assertTrue(a.isInertLocal("data:text/plain,x"))
        assertFalse(a.isInertLocal("about:srcdoc"))
        assertFalse(a.isInertLocal("file:///x"))
        assertFalse(a.isInertLocal(null))
    }
}
