package ch.kscw.pointhub.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackupRotationTest {
    private fun e(i: Int, bytes: Long = 100, at: Long = i * 1000L) = BackupEntry("f$i", bytes, at)

    @Test fun fiftyOneFilesDropsOldest() {
        val files = (1..51).map { e(it) }.shuffled()
        assertEquals(listOf("f1"), BackupRotation.toDelete(files))
    }

    @Test fun underLimitsDeletesNothing() = assertEquals(emptyList<String>(), BackupRotation.toDelete((1..50).map { e(it) }))

    @Test fun byteCap() {
        val mb = 1024L * 1024
        val files = (1..10).map { e(it, bytes = 3 * mb) } // 30 MB total, cap 20 MB → keep 6 newest
        assertEquals(listOf("f4", "f3", "f2", "f1"), BackupRotation.toDelete(files))
    }

    @Test fun newestAlwaysKeptEvenIfHuge() {
        val files = listOf(e(1, 10), e(2, 30L * 1024 * 1024))
        assertEquals(listOf("f1"), BackupRotation.toDelete(files))
    }

    @Test fun equalTimestampsStableByName() {
        // mtime has 1 s resolution on some file systems: the time-sortable name breaks the tie.
        val files = listOf(BackupEntry("20260101T000000.000Z_a.json", 1, 5), BackupEntry("20260101T000000.002Z_a.json", 1, 5),
            BackupEntry("20260101T000000.001Z_a.json", 1, 5))
        assertEquals(listOf("20260101T000000.001Z_a.json", "20260101T000000.000Z_a.json"), BackupRotation.toDelete(files, maxFiles = 1))
    }

    @Test fun nameSanitisation() {
        assertEquals("match-4711", BackupNames.sanitize("match 4711"))
        assertEquals("backup", BackupNames.sanitize(null))
        assertEquals("backup", BackupNames.sanitize("../../"))
        assertEquals("etc-passwd", BackupNames.sanitize("/etc/passwd"))
        assertEquals("a", BackupNames.sanitize("a.json"))
        assertEquals("Z-rich-VBC", BackupNames.sanitize("Zürich VBC"))
        assertEquals(80, BackupNames.sanitize("x".repeat(200)).length)
    }

    @Test fun fileNamesSortByTime() {
        val a = BackupNames.fileName(1_700_000_000_000, "m")
        val b = BackupNames.fileName(1_700_000_000_001, "m")
        assertTrue(a < b)
        assertEquals("20231114T221320.000Z_m.json", a)
        assertTrue(BackupNames.isBackupFile(a))
        assertFalse(BackupNames.isBackupFile("schedule.json"))
        assertFalse(BackupNames.isBackupFile("$a.tmp"))
    }
}

class BackupNamesStampTest {
    @Test fun stampRoundTrip() {
        val t = 1_758_123_456_789L
        assertEquals(t, BackupNames.parseStamp(BackupNames.fileName(t, "x")))
        assertEquals(null, BackupNames.parseStamp("garbage_x.json"))
    }
}
