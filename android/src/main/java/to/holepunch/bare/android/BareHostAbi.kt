package to.holepunch.bare.android

import android.os.Build

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

    /** True when the device can run at least one supported 64-bit ABI. */
    fun hasSupportedAbi(): Boolean = has64BitAbi(Build.SUPPORTED_ABIS.toList())

    /** Throw [IllegalStateException] on a 32-bit-only runtime. */
    fun requireSupportedAbi() {
        if (!hasSupportedAbi()) {
            throw IllegalStateException(
                "Bare host does not support 32-bit-only Android runtimes " +
                    "(supported ABIs: ${Build.SUPPORTED_ABIS.joinToString()}). " +
                    "This device is `zygote32`; bare-host requires a 64-bit ABI " +
                    "(arm64-v8a or x86_64). See ekrooh#46.",
            )
        }
    }
}
