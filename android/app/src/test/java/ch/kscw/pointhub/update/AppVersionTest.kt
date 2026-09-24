package ch.kscw.pointhub.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppVersionTest {
    private val origin = "http://172.24.1.1:8890"
    private val sha = "a".repeat(64)
    private fun json(code: Any = 13, url: String = "/app/pointhub.apk", hash: String = sha) =
        """{"versionCode":$code,"versionName":"1.0.4","sha256":"$hash","url":"$url","notes":"n","size":123}"""

    @Test fun parsesValid() {
        val v = AppVersion.parse(json(), origin)!!
        assertEquals(13, v.versionCode)
        assertEquals("1.0.4", v.versionName)
        assertEquals("$origin/app/pointhub.apk", v.apkUrl)
        assertEquals(123L, v.size)
    }

    @Test fun isNewer() {
        val v = AppVersion.parse(json(), origin)!!
        assertTrue(AppVersion.isNewer(v, 12))
        assertFalse(AppVersion.isNewer(v, 13))
        assertFalse(AppVersion.isNewer(v, 14))
    }

    @Test fun uppercaseHexNormalised() = assertEquals(sha, AppVersion.parse(json(hash = "A".repeat(64)), origin)!!.sha256)

    @Test fun rejectsMalformed() {
        assertNull(AppVersion.parse("nope", origin))
        assertNull(AppVersion.parse("[]", origin))
        assertNull(AppVersion.parse(json(code = 0), origin))
        assertNull(AppVersion.parse(json(code = -3), origin))
        assertNull(AppVersion.parse(json(code = "\"13\""), origin))
        assertNull(AppVersion.parse(json(code = 1.5), origin))
        assertNull(AppVersion.parse(json(hash = "g".repeat(64)), origin))
        assertNull(AppVersion.parse(json(hash = "a".repeat(63)), origin))
        assertNull(AppVersion.parse("""{"versionCode":2,"sha256":"$sha"}""", origin))
    }

    @Test fun urlOriginRules() {
        assertEquals("$origin/app/x.apk", AppVersion.parse(json(url = "$origin/app/x.apk"), origin)!!.apkUrl)
        assertNull(AppVersion.parse(json(url = "http://evil.example/app/pointhub.apk"), origin))
        assertNull(AppVersion.parse(json(url = "https://172.24.1.1:8890/app/pointhub.apk"), origin))
        assertNull(AppVersion.parse(json(url = "/other/pointhub.apk"), origin))
        assertNull(AppVersion.parse(json(url = "/app/../secret"), origin))
        assertNull(AppVersion.parse(json(url = "//evil.example/app/x.apk"), origin))
        assertNull(AppVersion.parse(json(url = "pointhub.apk"), origin))
    }
}
