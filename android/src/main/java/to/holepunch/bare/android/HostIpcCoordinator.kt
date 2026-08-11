package to.holepunch.bare.android

import android.util.Log
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
    fun start() {
        ipc.readable {
            try {
                val data = ipc.read() ?: return@readable
                val raw = ByteArray(data.remaining()).also { data.get(it) }
                val message = BareProtocol.parseMessage(ByteBuffer.wrap(raw)) ?: return@readable
                val headerObj = JSONObject(message.header)
                when (headerObj.optString("type")) {
                    "HOST_CAPABILITIES_QUERY" -> {
                        val reqId = headerObj.getString("requestId")
                        val resp = JSONObject().apply {
                            put("type", "HOST_CAPABILITIES_RESPONSE")
                            put("requestId", reqId)
                            put("capabilities", hostPlugins.toCapabilitiesJson())
                        }
                        val buf = BareProtocol.buildMessage(
                            BareProtocol.MessageType.ENVELOPE,
                            resp.toString(),
                            null,
                        )
                        ipc.write(buf)
                    }
                    "HOST_INVOKE_REQUEST" -> {
                        val reqId = headerObj.getString("requestId")
                        val pluginId = headerObj.getString("pluginId")
                        val event = headerObj.getString("event")
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
                            val buf = BareProtocol.buildMessage(
                                BareProtocol.MessageType.ENVELOPE,
                                respHeader.toString(),
                                null,
                            )
                            ipc.write(buf)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("BARE_KOTLIN", "Error in readable callback", e)
            }
        }
    }
}
