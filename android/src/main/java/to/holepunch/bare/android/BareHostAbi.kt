package to.holepunch.bare.android

import android.os.Build
import android.os.Process

/**
 * Supported-ABI policy for the Bare host (documented in
 * `docs/adr/0002-android-abi-support.md`).
 *
 * Bare Kit is built and shipped for four ABIs, but only **64-bit** runtimes
 * (`arm64-v8a`, `x86_64`) are supported on-device. The 32-bit ABIs
 * (`armeabi-v7a`, `x86`) are kept so the AAR installs on 32-bit-capable
 * devices and 32-bit emulators, but a **32-bit-only** device (`zygote32`,
 * where `Build.SUPPORTED_ABIS` contains no 64-bit entry) is out of scope:
 * the worklet's native thread bootstrap is not reliable there, so we fail
 * fast with a clear error instead of a native SIGSEGV (see ekrooh#46).
 */
object BareHostAbi {
    private val SUPPORTED_64_BIT_ABIS = setOf("arm64-v8a", "x86_64")

    /** True when [abis] contains at least one supported 64-bit ABI. Exposed
     * as a pure predicate for unit testing; prefer [hasSupportedAbi]. */
    fun has64BitAbi(abis: List<String>): Boolean =
        abis.any { it in SUPPORTED_64_BIT_ABIS }

    /** True when a process with [is64BitProcess] on a device with [abis]
     * runs the worklet on a supported runtime: the device has a supported
     * 64-bit ABI **and** this process actually runs as 64-bit. A 64-bit device
     * can still start an app as 32-bit (e.g. when an APK ships some native
     * library only for a 32-bit ABI), and that process is unsupported too. */
    fun isSupportedRuntime(is64BitProcess: Boolean, abis: List<String>): Boolean =
        is64BitProcess && has64BitAbi(abis)

    /** True when this process runs on a supported 64-bit runtime. */
    fun hasSupportedAbi(): Boolean =
        isSupportedRuntime(Process.is64Bit(), Build.SUPPORTED_ABIS.toList())

    /** Throw [IllegalStateException] on a 32-bit-only runtime or in a 32-bit
     * process. */
    fun requireSupportedAbi() {
        if (!hasSupportedAbi()) {
            throw IllegalStateException(
                "Bare host does not support 32-bit Android runtimes " +
                    "(supported ABIs: ${Build.SUPPORTED_ABIS.joinToString()}, " +
                    "64-bit process: ${Process.is64Bit()}). bare-host requires a " +
                    "64-bit process on a 64-bit ABI (arm64-v8a or x86_64). See ekrooh#46.",
            )
        }
    }
}
