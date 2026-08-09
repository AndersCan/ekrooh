package to.holepunch.bare.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
}
