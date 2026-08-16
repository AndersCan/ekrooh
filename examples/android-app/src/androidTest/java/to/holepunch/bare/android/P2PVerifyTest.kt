package to.holepunch.bare.android

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import to.holepunch.bare.kit.Worklet
import java.io.File

/**
 * Issue #41 reproduction gate on the Android emulator: boots the p2p verify
 * worklet (`core/p2p-verify.core.ts`, packed as `p2p-verify.bundle`) — the
 * same worklet the iOS `P2PVerifyTest` and the `smoke:p2p` script run — and
 * asserts it completes. The worklet covers the exact on-device flow the
 * photo app times out on: a reader opens a peer's drive by key, `ready()`s
 * it, and reads a photo over a real hyperswarm connection (rocksdb + udx +
 * sodium all native on-device). Writes `p2p-verify.ok` (or `.fail`) into its
 * storage dir and exits.
 */
@RunWith(AndroidJUnit4::class)
class P2PVerifyTest {

    @Test
    fun p2pVerifyRunsOnEmulator() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val storageDir = File(context.cacheDir, "p2p-verify-${System.currentTimeMillis()}")
        storageDir.mkdirs()

        val worklet = Worklet(
            Worklet.Options()
                .memoryLimit(128 * 1024 * 1024)
                .assets(File(storageDir, "asset-cache").absolutePath),
        )

        try {
            context.assets.open("p2p-verify.bundle").use { bundle ->
                worklet.start("/p2p-verify.bundle", bundle, arrayOf(storageDir.absolutePath))
            }

            val okMarker = File(storageDir, "p2p-verify.ok")
            val failMarker = File(storageDir, "p2p-verify.fail")
            val deadline = System.currentTimeMillis() + 240_000
            while (System.currentTimeMillis() < deadline) {
                if (okMarker.exists()) return
                if (failMarker.exists()) {
                    fail("p2p verify failed: ${failMarker.readText()}")
                }
                Thread.sleep(500)
            }
            fail("p2p verify did not complete within 240s")
        } finally {
            worklet.terminate()
        }
    }
}
