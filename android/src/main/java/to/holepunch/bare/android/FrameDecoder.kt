package to.holepunch.bare.android

import java.nio.ByteBuffer

/**
 * Receive-side frame reassembler for the host→worklet IPC byte stream.
 *
 * `BareKit`'s `IPC` does not preserve message boundaries, so a frame may arrive
 * split across chunks or with several frames coalesced into one. This buffers
 * partial bytes until the binary length prefix (`headerLen` + `payloadLen`)
 * proves a complete frame is available, then parses exactly `frameLen` bytes and
 * keeps the remainder for the next `push`. It mirrors
 * `core/messages/framing.ts`'s `createFrameDecoder` so an oversized or
 * header-truncated frame drops precisely the corrupt bytes (self-resync) and a
 * complete frame that fails to parse is skipped rather than desyncing the rest
 * of the stream.
 */
class FrameDecoder {
    private var buffer: ByteArray = ByteArray(0)
    var error: Exception? = null
        private set

    fun push(chunk: ByteArray): List<BareProtocol.WireMessage> {
        if (error != null) return emptyList()
        buffer = buffer + chunk

        val out = mutableListOf<BareProtocol.WireMessage>()
        while (buffer.size >= 7) {
            val headerLen = ((buffer[2].toInt() and 0xff) shl 8) or (buffer[3].toInt() and 0xff)
            if (headerLen > BareProtocol.MAX_HEADER_BYTES) {
                fail(
                    IllegalArgumentException(
                        "Header too large: $headerLen bytes, maximum is ${BareProtocol.MAX_HEADER_BYTES}",
                    ),
                )
                return out
            }
            val payloadLen =
                ((buffer[4].toInt() and 0xff) shl 16) or
                    ((buffer[5].toInt() and 0xff) shl 8) or
                    (buffer[6].toInt() and 0xff)
            val frameLen = 7 + headerLen + payloadLen
            if (frameLen > BareProtocol.MAX_FRAME_BYTES) {
                fail(
                    IllegalArgumentException(
                        "Frame too large: $frameLen bytes, maximum is ${BareProtocol.MAX_FRAME_BYTES}",
                    ),
                )
                return out
            }
            if (buffer.size < frameLen) break

            val frame = buffer.copyOfRange(0, frameLen)
            buffer = buffer.copyOfRange(frameLen, buffer.size)
            BareProtocol.parseMessage(ByteBuffer.wrap(frame))?.let { out.add(it) }
        }

        // A partial longer than the frame cap can never complete a legal frame.
        if (buffer.size > BareProtocol.MAX_FRAME_BYTES) {
            fail(
                IllegalArgumentException(
                    "Frame buffer exceeded ${BareProtocol.MAX_FRAME_BYTES} bytes with no complete frame",
                ),
            )
        }

        return out
    }

    fun clear() {
        buffer = ByteArray(0)
        error = null
    }

    private fun fail(e: Exception) {
        error = e
        // Drop everything buffered: a corrupt byte in the pending partial desyncs
        // the stream, so the only safe resync point is a fresh frame boundary.
        buffer = ByteArray(0)
    }
}
