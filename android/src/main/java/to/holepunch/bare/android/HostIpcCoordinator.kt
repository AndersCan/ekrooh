package to.holepunch.bare.android

import android.util.Log
import org.json.JSONException
import org.json.JSONObject
import to.holepunch.bare.kit.IPC
import java.nio.ByteBuffer

/**
 * Handles host-side IPC: capability queries and host invokes. The web layer
 * talks to the worklet over the loopback WebSocket socket, so nothing is
 * relayed to a WebView here.
 */
class HostIpcCoordinator(
    private val ipc: IPC,
    private val hostPlugins: HostPluginRegistry,
) {
    companion object {
        private const val MAX_FIELD_BYTES = 256
    }

    private val decoder = FrameDecoder()

    fun start() {
        ipc.readable {
            try {
                val data = ipc.read() ?: return@readable
                val raw = ByteArray(data.remaining()).also { data.get(it) }
                val messages = decoder.push(raw)
                // A framing violation marks the decoder inert but still returns the
                // frames decoded before it; drop the corrupt byte stream and resync.
                if (decoder.error != null) {
                    if (BuildConfig.DEBUG) Log.e("BARE_KOTLIN", "IPC frame decoder desynced; resetting")
                    decoder.clear()
                }
                for (message in messages) {
                    dispatch(message)
                }
            } catch (e: Exception) {
                // The readable loop must survive any thrown frame so a single
                // malformed/oversized envelope never permanently stalls all host
                // invokes. Logging is debug-only (URLs/tokens may transit here).
                if (BuildConfig.DEBUG) Log.e("BARE_KOTLIN", "Error in readable callback", e)
            }
        }
    }

    private fun dispatch(message: BareProtocol.WireMessage) {
        val headerObj = try {
            JSONObject(message.header)
        } catch (e: JSONException) {
            // Header was not valid JSON: answer with an error frame so the
            // web layer never waits on an unanswered correlation id, then
            // re-arm the readable loop and continue.
            writeError(null, ErrorCodes.FRAME_INVALID, "Invalid envelope header")
            return
        }
        when (headerObj.optString("type")) {
            "HOST_CAPABILITIES_QUERY" -> {
                val reqId = headerObj.optString("requestId")
                if (!validField(reqId)) {
                    writeError(null, ErrorCodes.FRAME_INVALID, "Missing or invalid requestId")
                    return
                }
                val resp = JSONObject().apply {
                    put("type", "HOST_CAPABILITIES_RESPONSE")
                    put("requestId", reqId)
                    put("capabilities", hostPlugins.toCapabilitiesJson())
                }
                ipc.write(
                    BareProtocol.buildMessage(
                        BareProtocol.MessageType.ENVELOPE,
                        resp.toString(),
                        null,
                    ),
                )
            }
            "HOST_INVOKE_REQUEST" -> {
                val reqId = headerObj.optString("requestId")
                val pluginId = headerObj.optString("pluginId")
                val event = headerObj.optString("event")
                if (!validField(reqId) || !validField(pluginId) || !validField(event)) {
                    // Echo the original header (if any) so a correlated error
                    // frame is returned; never let one bad frame stall the loop.
                    writeError(message.header, ErrorCodes.FRAME_INVALID, "Malformed HOST_INVOKE_REQUEST")
                    return
                }
                val args = headerObj.optJSONObject("args")
                hostPlugins.dispatch(pluginId, event, args, message.payload) { outcome ->
                    val respHeader = JSONObject().apply {
                        put("type", "HOST_INVOKE_RESPONSE")
                        put("requestId", reqId)
                        put("pluginId", pluginId)
                        put("event", event)
                    }
                    when (outcome) {
                        is HostPluginRegistry.HostInvokeOutcome.Ok ->
                            respHeader.put("result", outcome.value)
                        is HostPluginRegistry.HostInvokeOutcome.Fail ->
                            respHeader.put(
                                "error",
                                JSONObject().apply {
                                    put("code", outcome.code)
                                    put("message", outcome.message)
                                },
                            )
                    }
                    try {
                        ipc.write(
                            BareProtocol.buildMessage(
                                BareProtocol.MessageType.ENVELOPE,
                                respHeader.toString(),
                                null,
                            ),
                        )
                    } catch (e: Exception) {
                        if (BuildConfig.DEBUG) Log.e("BARE_KOTLIN", "Failed to write invoke response", e)
                    }
                }
            }
            else -> {
                writeError(message.header, ErrorCodes.FRAME_INVALID, "Unknown envelope type")
                return
            }
        }
    }

    private fun writeError(requestHeader: String?, code: String, message: String) {
        try {
            val header = requestHeader ?: "{}"
            val err = BareProtocol.buildErrorResponse(
                header,
                code,
                message,
                "HOST_INVOKE_RESPONSE",
            )
            ipc.write(BareProtocol.buildMessage(err.type, err.header, err.payload))
        } catch (e: Exception) {
            if (BuildConfig.DEBUG) Log.e("BARE_KOTLIN", "Failed to write error frame", e)
        }
    }

    private fun validField(s: String): Boolean = s.length in 1..MAX_FIELD_BYTES
}
