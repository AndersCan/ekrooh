package to.holepunch.bare.android

import java.io.File

/**
 * One-time move of the worklet storage that older builds kept under
 * `cacheDir/bare` into its durable home (`noBackupFilesDir/bare`).
 *
 * Keyed on the legacy directory still existing, not on the new one missing:
 * a move that failed once is retried on the next launch. A failed move never
 * starts an empty store in its place: this launch keeps using the legacy
 * directory (so the p2p identity and data stay reachable) and says so loudly.
 */
object StorageMigration {
    /**
     * Returns the directory the worklet should use as storage this launch:
     * [target] when there is nothing to migrate or the move worked, [legacy]
     * when the move failed. [log] receives every non-routine outcome.
     */
    fun resolve(legacy: File, target: File, log: (String) -> Unit): File {
        if (!legacy.isDirectory) return target
        if (target.exists() && !isEmptyStore(target)) {
            // Both hold data (e.g. an earlier build ran without migrating).
            // Never merge or overwrite: keep the new store, keep the legacy
            // copy for recovery, and keep saying so.
            log(
                "Legacy worklet storage at ${legacy.path} was NOT migrated: ${target.path} " +
                    "already holds data. Using ${target.path}; the legacy copy is kept for recovery.",
            )
            return target
        }
        // An empty target (left by a failed attempt) is not data: replace it.
        if (target.exists()) target.deleteRecursively()
        target.parentFile?.mkdirs()
        if (legacy.renameTo(target)) {
            // The asset cache is cache, not storage: it now lives in bare-cache.
            File(target, "asset-cache").deleteRecursively()
            return target
        }
        log(
            "Could NOT move legacy worklet storage ${legacy.path} to ${target.path}. " +
                "Using the legacy directory for this launch; the move is retried on the next launch.",
        )
        return legacy
    }

    /** True when [dir] holds no worklet data (only a stale handoff, if any). */
    private fun isEmptyStore(dir: File): Boolean =
        dir.listFiles()?.all { it.name.startsWith("handoff.json") } ?: true
}
