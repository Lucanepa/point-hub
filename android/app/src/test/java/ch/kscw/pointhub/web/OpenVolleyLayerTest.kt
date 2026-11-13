package ch.kscw.pointhub.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenVolleyLayerTest {
    @Test fun keepsOpenVolleysOwnNames() {
        assertEquals("Scoresheet_MUST_TEST_2026-11-13.pdf", OpenVolleyLayer.safeName("Scoresheet_MUST_TEST_2026-11-13.pdf", "application/pdf"))
        assertEquals("match 4711.zip", OpenVolleyLayer.safeName("match 4711.zip", "application/zip"))
    }

    @Test fun neverAPathOrAHiddenFile() {
        assertEquals("passwd", OpenVolleyLayer.safeName("../../etc/passwd", "text/plain"))
        assertEquals("x.pdf", OpenVolleyLayer.safeName("C:\\temp\\x.pdf", "application/pdf"))
        assertEquals("env", OpenVolleyLayer.safeName(".env", "text/plain"))
        assertEquals("a_b_c.json", OpenVolleyLayer.safeName("a:b*c.json", "application/json"))
    }

    @Test fun aNameWhenThePageGaveNone() {
        assertTrue(OpenVolleyLayer.safeName("", "application/pdf").matches(Regex("openvolley-\\d+\\.pdf")))
        assertTrue(OpenVolleyLayer.safeName(null, "application/x-unknown").endsWith(".bin"))
    }

    @Test fun theShimOnlyTalksToItsOwnChannel() {
        val s = OpenVolleyLayer.DOWNLOAD_SHIM
        assertTrue(s.contains("window.PointHubFiles.postMessage"))
        assertTrue(s.contains("/^(blob|data):/"))
        assertTrue(!s.contains("PointHubApp"))
    }
}
