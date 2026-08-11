package to.holepunch.bare.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.ByteBuffer

class BareProtocolTest {
    private val header = """{"type":"DISPATCH","pluginId":"core.health","event":"health.ping"}"""

    @Test
    fun `round-trips type header and payload`() {
        val payload = byteArrayOf(1, 2, 3)
        val buffer = BareProtocol.buildMessage(BareProtocol.MessageType.ENVELOPE, header, payload)

        val msg = BareProtocol.parseMessage(buffer)
        assertTrue(msg != null)
        assertEquals(BareProtocol.MessageType.ENVELOPE, msg!!.type)
        assertEquals(header, msg.header)
        assertArrayEquals(payload, msg.payload)
    }

    @Test
    fun `parses a null payload as null`() {
        val buffer = BareProtocol.buildMessage(BareProtocol.MessageType.ENVELOPE, header, null)
        val msg = BareProtocol.parseMessage(buffer)
        assertTrue(msg != null)
        assertNull(msg!!.payload)
    }

    @Test
    fun `rejects an unsupported version`() {
        val buffer = BareProtocol.buildMessage(BareProtocol.MessageType.ENVELOPE, header, null)
        buffer.put(0, 99.toByte())
        assertNull(BareProtocol.parseMessage(buffer))
    }

    @Test
    fun `rejects an unsupported message type`() {
        val buffer = BareProtocol.buildMessage(BareProtocol.MessageType.ENVELOPE, header, null)
        buffer.put(1, 250.toByte())
        assertNull(BareProtocol.parseMessage(buffer))
    }

    @Test
    fun `returns null for a truncated buffer`() {
        val full = BareProtocol.buildMessage(BareProtocol.MessageType.ENVELOPE, header, null)
        val bytes = ByteArray(full.remaining())
        full.get(bytes)
        val truncated = ByteBuffer.wrap(bytes.copyOf(bytes.size - 1))
        assertNull(BareProtocol.parseMessage(truncated))
    }

    @Test
    fun `rejects a header larger than the 16-bit length field`() {
        val bigHeader = """{"type":"DISPATCH","pluginId":"core.health","event":"e","args":{"x":"${"y".repeat(0x10000)}"}}"""
        assertThrows(IllegalArgumentException::class.java) {
            BareProtocol.buildMessage(BareProtocol.MessageType.ENVELOPE, bigHeader, null)
        }
    }

    @Test
    fun `rejects a frame larger than the maximum`() {
        val payload = ByteArray(BareProtocol.MAX_FRAME_BYTES)
        assertThrows(IllegalArgumentException::class.java) {
            BareProtocol.buildMessage(BareProtocol.MessageType.ENVELOPE, header, payload)
        }
    }

    @Test
    fun `returns null for an oversized frame on parse`() {
        val payload = ByteArray(BareProtocol.MAX_FRAME_BYTES + 1)
        val buffer = ByteBuffer.allocateDirect(4 + payload.size)
        buffer.put(BareProtocol.VERSION)
        buffer.put(BareProtocol.MessageType.ENVELOPE)
        buffer.putShort(payload.size.toShort())
        buffer.put(payload)
        buffer.flip()
        assertNull(BareProtocol.parseMessage(buffer))
    }

    @Test
    fun `builds an INVOKE_RESPONSE error envelope from a request header`() {
        val requestHeader = """{"type":"INVOKE_REQUEST","pluginId":"core.health","event":"health.ping","requestId":"req-1"}"""
        val err = BareProtocol.buildErrorResponse(
            requestHeader,
            ErrorCodes.FRAME_TOO_LARGE,
            "too big",
        )
        assertEquals(BareProtocol.MessageType.ENVELOPE, err.type)
        assertTrue(err.header.contains("\"requestId\":\"req-1\""))
        assertTrue(err.header.contains("\"code\":\"FRAME_TOO_LARGE\""))
        assertNull(err.payload)
    }
}
