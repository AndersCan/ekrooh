package to.holepunch.bare.android

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets

object BareProtocol {
    const val VERSION: Byte = 1

    /** Mirror of `MAX_HEADER_BYTES` in `core/messages/constants.ts`. */
    const val MAX_HEADER_BYTES: Int = 0xffff

    /** Mirror of `MAX_FRAME_BYTES` in `core/messages/constants.ts`. */
    const val MAX_FRAME_BYTES: Int = 16 * 1024 * 1024

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
        if (headerBytes.size > MAX_HEADER_BYTES) {
            throw IllegalArgumentException(
                "Header too large: ${headerBytes.size} bytes, maximum is $MAX_HEADER_BYTES"
            )
        }
        val payloadBytes = payload ?: ByteArray(0)

        // [version][type][headerLen(2 BE)][payloadLen(3 BE)][header][payload]:
        // the binary payload length keeps frames self-delimiting even when a
        // transport re-serializes the JSON header (mirrors core wire-codec).
        val totalLength = 7 + headerBytes.size + payloadBytes.size
        if (totalLength > MAX_FRAME_BYTES) {
            throw IllegalArgumentException(
                "Frame too large: $totalLength bytes, maximum is $MAX_FRAME_BYTES"
            )
        }
        val buffer = ByteBuffer.allocateDirect(totalLength)

        buffer.put(VERSION)
        buffer.put(type)
        buffer.putShort(headerBytes.size.toShort())
        buffer.put(((payloadBytes.size shr 16) and 0xff).toByte())
        buffer.put(((payloadBytes.size shr 8) and 0xff).toByte())
        buffer.put((payloadBytes.size and 0xff).toByte())
        buffer.put(headerBytes)
        buffer.put(payloadBytes)

        buffer.flip()
        return buffer
    }

    fun parseMessage(buffer: ByteBuffer): WireMessage? {
        if (buffer.remaining() < 7) return null
        if (buffer.remaining() > MAX_FRAME_BYTES) return null

        val version = buffer.get()
        if (version != VERSION) return null

        val type = buffer.get()
        if (type != MessageType.ENVELOPE) return null
        val headerLen = buffer.short.toInt() and 0xFFFF
        val payloadLen =
            ((buffer.get().toInt() and 0xff) shl 16) or
                ((buffer.get().toInt() and 0xff) shl 8) or
                (buffer.get().toInt() and 0xff)

        if (headerLen > MAX_HEADER_BYTES) return null
        if (buffer.remaining() < headerLen) return null
        val headerBytes = ByteArray(headerLen)
        buffer.get(headerBytes)
        val headerJson = String(headerBytes, StandardCharsets.UTF_8)

        val payload = if (buffer.remaining() >= payloadLen && payloadLen > 0) {
            val bytes = ByteArray(payloadLen)
            buffer.get(bytes)
            bytes
        } else {
            null
        }

        return WireMessage(type, headerJson, payload)
    }

    /**
     * Builds an error envelope for a frame the bridge could not deliver, keyed
     * to the original request when possible. [type] controls the wire envelope
     * type (`INVOKE_RESPONSE` for worklet-bound errors, `HOST_INVOKE_RESPONSE`
     * for host IPC errors); it defaults to `INVOKE_RESPONSE` for parity with
     * the original caller contract.
     */
    fun buildErrorResponse(headerJson: String, code: String, message: String, type: String = "INVOKE_RESPONSE"): WireMessage {
        val request = try {
            JSONObject(headerJson)
        } catch (e: Exception) {
            JSONObject()
        }
        val response = JSONObject().apply {
            put("type", type)
            put("pluginId", request.optString("pluginId"))
            put("event", request.optString("event"))
            if (request.has("requestId")) put("requestId", request.getString("requestId"))
            put(
                "error",
                JSONObject().apply {
                    put("code", code)
                    put("message", message)
                },
            )
        }
        return WireMessage(MessageType.ENVELOPE, response.toString(), null)
    }
}
