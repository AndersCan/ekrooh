package to.holepunch.bare.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class StorageMigrationTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val logs = mutableListOf<String>()

    private fun dirs(): Pair<File, File> {
        val legacy = File(tmp.root, "cache/bare")
        val target = File(tmp.root, "no_backup/bare")
        return legacy to target
    }

    @Test
    fun `nothing to migrate uses the new store quietly`() {
        val (legacy, target) = dirs()
        assertEquals(target, StorageMigration.resolve(legacy, target) { logs += it })
        assertTrue(logs.isEmpty())
    }

    @Test
    fun `moves the legacy store and drops its asset cache`() {
        val (legacy, target) = dirs()
        File(legacy, "corestore").mkdirs()
        File(legacy, "corestore/key").writeText("k")
        File(legacy, "asset-cache").mkdirs()
        assertEquals(target, StorageMigration.resolve(legacy, target) { logs += it })
        assertFalse(legacy.exists())
        assertEquals("k", File(target, "corestore/key").readText())
        assertFalse(File(target, "asset-cache").exists())
    }

    @Test
    fun `an empty store left by an earlier failure does not block the retry`() {
        val (legacy, target) = dirs()
        File(legacy, "corestore").mkdirs()
        target.mkdirs()
        File(target, "handoff.json").writeText("{}")
        assertEquals(target, StorageMigration.resolve(legacy, target) { logs += it })
        assertTrue(File(target, "corestore").isDirectory)
        assertFalse(legacy.exists())
    }

    @Test
    fun `a failed move keeps using the legacy store and says so`() {
        val (legacy, target) = dirs()
        File(legacy, "corestore").mkdirs()
        // The target's parent is a file, so the move cannot succeed.
        target.parentFile!!.parentFile!!.mkdirs()
        target.parentFile!!.writeText("not a directory")
        assertEquals(legacy, StorageMigration.resolve(legacy, target) { logs += it })
        assertTrue(File(legacy, "corestore").isDirectory)
        assertEquals(1, logs.size)
        assertTrue(logs[0].contains("Could NOT move"))
    }

    @Test
    fun `never overwrites a store that already holds data`() {
        val (legacy, target) = dirs()
        File(legacy, "corestore").mkdirs()
        File(target, "corestore").mkdirs()
        File(target, "corestore/key").writeText("new")
        assertEquals(target, StorageMigration.resolve(legacy, target) { logs += it })
        assertEquals("new", File(target, "corestore/key").readText())
        assertTrue("legacy kept for recovery", legacy.isDirectory)
        assertTrue(logs.single().contains("NOT migrated"))
    }
}
