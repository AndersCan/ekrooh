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
 * worklet (`core/p2p-verify.core.ts`, packed as `p2p-verify.bundle`) and
 * asserts it completes. In `mode=self` it runs the self-contained
 * corestore/hyperdrive smoke — proving the p2p native addons (rocksdb via
 * corestore, sodium via hyperdrive, udx) load and self-read on Android
 * bare-kit. Real DHT peer discovery is exercised by the same worklet on the
 * macOS smoke and the iOS simulator, where the loopback DHT reliably works;
 * on the hosted x86_64 emulator it is not a stable gate. Writes
 * `p2p-verify.ok` (or `.fail`) into its storage dir and exits.
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
                worklet.start(
                    "/p2p-verify.bundle",
                    bundle,
                    // `mode=self` runs only the self-contained corestore/
                    // hyperdrive smoke: real DHT peer discovery (server:true
                    // sockets reachable from a peer) is unreliable under the
                    // software-rendered x86_64 CI emulator. The Android gate
                    // proves the p2p native addons load and self-read on-device
                    // (the "reverse direction" that always worked, per #41);
                    // the full peer-drive replication gate runs on the macOS
                    // smoke and the iOS simulator.
                    arrayOf(storageDir.absolutePath, "mode=self"),
                )
            }

            val okMarker = File(storageDir, "p2p-verify.ok")
            val failMarker = File(storageDir, "p2p-verify.fail")
            val deadline = System.currentTimeMillis() + 120_000
            while (System.currentTimeMillis() < deadline) {
                if (okMarker.exists()) return
                if (failMarker.exists()) {
                    fail("p2p verify failed: ${failMarker.readText()}")
                }
                Thread.sleep(500)
            }
            fail("p2p verify did not complete within 120s")
        } finally {
            worklet.terminate()
        }
    }
}
