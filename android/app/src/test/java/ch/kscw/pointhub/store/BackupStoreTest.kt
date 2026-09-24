package ch.kscw.pointhub.store

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipInputStream

class BackupStoreTest {
    @get:Rule val tmp = TemporaryFolder()
    private var now = 1_758_000_000_000L
    private fun store(maxFiles: Int = 50) = BackupStore(File(tmp.root, "backups"), { now }, maxFiles)

    @Test fun saveListNewestFirst() {
        val s = store()
        val a = s.save("match-1", """{"a":1}""")
        now += 1000
        val b = s.save("match-2", """[1,2]""")
        assertNotNull(a); assertNotNull(b)
        assertEquals(listOf(b, a), s.list().map { it.name })
        val arr = JSONArray(s.listJson())
        assertEquals(b, arr.getJSONObject(0).getString("name"))
        assertTrue(arr.getJSONObject(0).getString("savedAt").endsWith("Z"))
        assertFalse(File(tmp.root, "backups").listFiles()!!.any { it.name.endsWith(".tmp") })
    }

    @Test fun rejectsInvalid() {
        val s = store()
        assertNull(s.save("x", "not json"))
        assertNull(s.save("x", "\"a string\""))
        assertNull(s.save("x", "{} trailing"))
        assertNull(s.save("x".repeat(81), "{}"))
        assertNull(s.save("x", "[" + "1,".repeat(3 * 1024 * 1024) + "1]"))
        assertTrue(s.list().isEmpty())
    }

    @Test fun sameMillisecondDoesNotOverwrite() {
        val s = store()
        val a = s.save("m", "{}")
        val b = s.save("m", "{\"b\":1}")
        assertTrue(a != b)
        assertEquals(2, s.list().size)
    }

    @Test fun rotates() {
        val s = store(maxFiles = 3)
        repeat(5) { s.save("m$it", "{}"); now += 1000 }
        assertEquals(listOf("m4", "m3", "m2"), s.list().map { it.name.substringAfter('_').removeSuffix(".json") })
    }

    @Test fun summaryOfNewest() {
        val s = store()
        s.save("old", """{"summary":{"title":"Old"}}""")
        now += 1000
        s.save("new", """{"summary":{"title":"Herren 2","home":"KSCW","away":"VBC Züri","sets":"25:21","score":"1:0","state":"live","n":5}}""")
        val m = s.newestSummary()!!
        assertEquals("Herren 2", m.title)
        assertEquals("VBC Züri", m.away)
        assertEquals("live", m.state)
        now += 1000
        s.save("bare", "{}")
        val bare = s.newestSummary()!!
        assertNull(bare.title)
        assertTrue(bare.backupName.endsWith("_bare.json"))
    }

    @Test fun zipContainsBackupsAndExtras() {
        val s = store()
        s.save("a", "{}"); now += 1; s.save("b", "[]")
        val out = ByteArrayOutputStream()
        val n = s.writeZip(out, mapOf("schedule.json" to "{}".toByteArray()))
        assertEquals(2, n)
        val names = ArrayList<String>()
        ZipInputStream(out.toByteArray().inputStream()).use { z ->
            while (true) { names += (z.nextEntry ?: break).name }
        }
        assertEquals(3, names.size)
        assertTrue(names.contains("schedule.json"))
        assertEquals(2, names.count { it.startsWith("backups/") })
    }

    @Test fun schedule() {
        val f = File(tmp.root, "schedule.json")
        val s = ScheduleStore(f)
        assertNull(s.load())
        assertFalse(s.save("nope"))
        assertTrue(s.save("""{"games":[]}"""))
        assertEquals("""{"games":[]}""", s.load())
        assertTrue(s.save("[]"))
        assertEquals("[]", s.load())
    }
}
