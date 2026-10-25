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
 *
 * Reassembly is linear in the bytes received: once the length prefix of an
 * incomplete frame is known the partial buffer is sized to that frame once and
 * filled in place as chunks arrive, rather than re-copying everything buffered
 * on every chunk.
 */
class FrameDecoder {
    private companion object {
        /** Smallest buffer allocated for a partial frame whose length is not yet known. */
        const val MIN_PARTIAL_BYTES = 64

        /** A partial buffer larger than this is released once drained. */
        const val RETAIN_BYTES = 64 * 1024
    }

    /** Partial-frame storage: the first [length] bytes are buffered data. */
    private var buffer: ByteArray = ByteArray(0)
    private var length = 0
    var error: Exception? = null
        private set

    fun push(chunk: ByteArray): List<BareProtocol.WireMessage> {
        if (error != null) return emptyList()

        val source: ByteArray
        val end: Int
        if (length == 0) {
            // Nothing buffered: decode straight from the caller's bytes.
            source = chunk
            end = chunk.size
        } else {
            reserve(length + chunk.size)
            chunk.copyInto(buffer, length)
            length += chunk.size
            source = buffer
            end = length
        }

        val out = mutableListOf<BareProtocol.WireMessage>()
        var offset = 0
        // Length of the incomplete frame at `offset`, once its prefix has arrived.
        var pendingFrameLen = 0
        while (end - offset >= 7) {
            val headerLen =
                ((source[offset + 2].toInt() and 0xff) shl 8) or (source[offset + 3].toInt() and 0xff)
            if (headerLen > BareProtocol.MAX_HEADER_BYTES) {
                fail(
                    IllegalArgumentException(
                        "Header too large: $headerLen bytes, maximum is ${BareProtocol.MAX_HEADER_BYTES}",
                    ),
                )
                return out
            }
            val payloadLen =
                ((source[offset + 4].toInt() and 0xff) shl 16) or
                    ((source[offset + 5].toInt() and 0xff) shl 8) or
                    (source[offset + 6].toInt() and 0xff)
            val frameLen = 7 + headerLen + payloadLen
            if (frameLen > BareProtocol.MAX_FRAME_BYTES) {
                fail(
                    IllegalArgumentException(
                        "Frame too large: $frameLen bytes, maximum is ${BareProtocol.MAX_FRAME_BYTES}",
                    ),
                )
                return out
            }
            if (end - offset < frameLen) {
                pendingFrameLen = frameLen
                break
            }

            val frame = source.copyOfRange(offset, offset + frameLen)
            offset += frameLen
            BareProtocol.parseMessage(ByteBuffer.wrap(frame))?.let { out.add(it) }
        }

        retain(source, offset, end, pendingFrameLen)

        // A partial longer than the frame cap can never complete a legal frame.
        if (length > BareProtocol.MAX_FRAME_BYTES) {
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
        length = 0
        error = null
    }

    /** Grows [buffer] to hold at least [bytes], preserving buffered data. */
    private fun reserve(bytes: Int) {
        if (buffer.size >= bytes) return
        val next = ByteArray(maxOf(bytes, MIN_PARTIAL_BYTES))
        buffer.copyInto(next, 0, 0, length)
        buffer = next
    }

    /**
     * Keeps the unconsumed tail `source[from, to)` as the buffered partial,
     * sized for [frameLen] when the incomplete frame's length is known.
     */
    private fun retain(source: ByteArray, from: Int, to: Int, frameLen: Int) {
        val rest = to - from
        if (rest == 0) {
            length = 0
            if (buffer.size > RETAIN_BYTES) buffer = ByteArray(0)
            return
        }
        if (source === buffer) {
            // Compact in place; copyInto handles the overlap.
            buffer.copyInto(buffer, 0, from, to)
            length = rest
            reserve(frameLen)
            return
        }
        // `source` is the caller's chunk: copy the tail out.
        length = 0
        reserve(maxOf(rest, frameLen))
        source.copyInto(buffer, 0, from, to)
        length = rest
    }

    private fun fail(e: Exception) {
        error = e
        // Drop everything buffered: a corrupt byte in the pending partial desyncs
        // the stream, so the only safe resync point is a fresh frame boundary.
        buffer = ByteArray(0)
        length = 0
    }
}
