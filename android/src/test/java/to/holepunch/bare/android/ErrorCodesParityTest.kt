package to.holepunch.bare.android

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Enforces that the Kotlin mirror of the TS `ErrorCode` union stays in sync
 * with `core/messages/constants.ts`. Extend when codes are added on either side.
 */
class ErrorCodesParityTest {
    @Test
    fun `Kotlin error codes match the canonical wire codes`() {
        assertEquals("UNSUPPORTED_CAPABILITY", ErrorCodes.UNSUPPORTED_CAPABILITY)
        assertEquals("UNSUPPORTED_EVENT", ErrorCodes.UNSUPPORTED_EVENT)
        assertEquals("HOST_ERROR", ErrorCodes.HOST_ERROR)
        assertEquals("TRANSPORT_ERROR", ErrorCodes.TRANSPORT_ERROR)
        assertEquals("PLUGIN_ERROR", ErrorCodes.PLUGIN_ERROR)
        assertEquals("INVALID_RESPONSE", ErrorCodes.INVALID_RESPONSE)
        assertEquals("FRAME_TOO_LARGE", ErrorCodes.FRAME_TOO_LARGE)
        assertEquals("FRAME_INVALID", ErrorCodes.FRAME_INVALID)
        assertEquals("TIMEOUT", ErrorCodes.TIMEOUT)
    }

    @Test
    fun `frame limits match the TS constants`() {
        assertEquals(0xffff, BareProtocol.MAX_HEADER_BYTES)
        assertEquals(16 * 1024 * 1024, BareProtocol.MAX_FRAME_BYTES)
    }
}
