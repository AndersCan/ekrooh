package to.holepunch.bare.android

/**
 * Canonical error codes, mirrored from `core/messages/constants.ts`.
 *
 * Keep this file in sync with the TypeScript `ErrorCode` union; the parity
 * test [ErrorCodesParityTest] enforces the contract.
 */
object ErrorCodes {
    const val UNSUPPORTED_CAPABILITY = "UNSUPPORTED_CAPABILITY"
    const val UNSUPPORTED_EVENT = "UNSUPPORTED_EVENT"
    const val HOST_ERROR = "HOST_ERROR"
    const val TRANSPORT_ERROR = "TRANSPORT_ERROR"
    const val PLUGIN_ERROR = "PLUGIN_ERROR"
    const val INVALID_RESPONSE = "INVALID_RESPONSE"
    const val FRAME_TOO_LARGE = "FRAME_TOO_LARGE"
    const val FRAME_INVALID = "FRAME_INVALID"
    const val TIMEOUT = "TIMEOUT"
}
