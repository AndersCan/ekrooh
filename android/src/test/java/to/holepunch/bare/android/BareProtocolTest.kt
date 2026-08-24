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

class FrameDecoderTest {
    private val header = """{"type":"DISPATCH","pluginId":"core.health","event":"health.ping"}"""

    private fun frame(payload: ByteArray? = null): ByteArray {
        val buffer = BareProtocol.buildMessage(BareProtocol.MessageType.ENVELOPE, header, payload)
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        return bytes
    }

    @Test
    fun `reassembles a frame split across chunks`() {
        val f = frame(byteArrayOf(1, 2, 3, 4))
        val decoder = FrameDecoder()
        val decoded = mutableListOf<BareProtocol.WireMessage>()
        for (i in f.indices) {
            decoded += decoder.push(f.copyOfRange(i, i + 1))
        }
        assertEquals(1, decoded.size)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), decoded[0].payload)
    }

    @Test
    fun `drains coalesced frames in order`() {
        val f1 = frame(null)
        val f2 = frame(byteArrayOf(9))
        val both = f1 + f2
        val decoder = FrameDecoder()
        val decoded = decoder.push(both)
        assertEquals(2, decoded.size)
        assertArrayEquals(byteArrayOf(9), decoded[1].payload)
    }

    @Test
    fun `skips a corrupt complete frame without desyncing the rest`() {
        val f1 = frame(null)
        val bad = frame(null).also { it[0] = 99 }
        val f2 = frame(byteArrayOf(7))
        val both = f1 + bad + f2
        val decoder = FrameDecoder()
        val decoded = decoder.push(both)
        // The corrupt frame is skipped; the two good frames still parse.
        assertEquals(2, decoded.size)
        assertArrayEquals(byteArrayOf(7), decoded[1].payload)
    }

    @Test
    fun `goes inert after a frame too large and resyncs on clear`() {
        val decoder = FrameDecoder()
        // headerLen 0, payloadLen 0xffffff: frameLen exceeds the cap (a framing
        // violation).
        val oversized = byteArrayOf(
            BareProtocol.VERSION,
            BareProtocol.MessageType.ENVELOPE,
            0, 0, 0xff.toByte(), 0xff.toByte(), 0xff.toByte(),
        )
        val first = decoder.push(oversized)
        assertEquals(0, first.size)
        assertTrue(decoder.error != null)

        decoder.clear()
        val good = decoder.push(frame(null))
        assertEquals(1, good.size)
        assertTrue(decoder.error == null)
    }
}
