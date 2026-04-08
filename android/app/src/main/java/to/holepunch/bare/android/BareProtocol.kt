package to.holepunch.bare.android

import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets

object BareProtocol {
    const val VERSION: Byte = 1

    object MessageType {
        const val ENVELOPE: Byte = 1
    }

    data class WireMessage(
        val type: Byte,
        val header: String,
        val payload: ByteArray? = null
    )

    fun buildMessage(type: Byte, headerJson: String, payload: ByteArray? = null): ByteBuffer {
        val headerBytes = headerJson.toByteArray(StandardCharsets.UTF_8)
        val payloadBytes = payload ?: ByteArray(0)

        // 1 (version) + 1 (type) + 2 (headerLen) + header + payload
        val totalLength = 4 + headerBytes.size + payloadBytes.size
        val buffer = ByteBuffer.allocateDirect(totalLength)

        buffer.put(VERSION)
        buffer.put(type)
        buffer.putShort(headerBytes.size.toShort())
        buffer.put(headerBytes)
        buffer.put(payloadBytes)

        buffer.flip()
        return buffer
    }

    fun parseMessage(buffer: ByteBuffer): WireMessage? {
        if (buffer.remaining() < 4) return null

        val version = buffer.get()
        if (version != VERSION) return null

        val type = buffer.get()
        if (type != MessageType.ENVELOPE) return null
        val headerLen = buffer.short.toInt() and 0xFFFF

        if (buffer.remaining() < headerLen) return null
        val headerBytes = ByteArray(headerLen)
        buffer.get(headerBytes)
        val headerJson = String(headerBytes, StandardCharsets.UTF_8)

        val payload = if (buffer.hasRemaining()) {
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            bytes
        } else {
            null
        }

        return WireMessage(type, headerJson, payload)
    }
}
