package to.holepunch.bare.android

import org.json.JSONArray
import org.json.JSONObject

/**
 * Registers host-side invoke handlers for events delegated from the Bare worklet over IPC.
 * Handlers respond asynchronously ([respond] may be called later, e.g. after an Activity
 * result), mirroring how native pickers/cameras return their payloads.
 */
class HostPluginRegistry {
    data class Key(val pluginId: String, val event: String)

    fun interface Handler {
        fun invoke(args: JSONObject?, payload: ByteArray?, respond: (HostInvokeOutcome) -> Unit)
    }

    sealed class HostInvokeOutcome {
        data class Ok(val value: JSONObject) : HostInvokeOutcome()
        data class Fail(val code: String, val message: String) : HostInvokeOutcome()
    }

    private val handlers = mutableMapOf<Key, Handler>()

    fun register(pluginId: String, event: String, handler: Handler) {
        handlers[Key(pluginId, event)] = handler
    }

    fun toCapabilitiesJson(): JSONArray {
        val byPlugin = mutableMapOf<String, MutableSet<String>>()
        for ((key, _) in handlers) {
            byPlugin.getOrPut(key.pluginId) { mutableSetOf() }.add(key.event)
        }
        val arr = JSONArray()
        for ((pluginId, events) in byPlugin) {
            val evArr = JSONArray()
            for (e in events.sorted()) evArr.put(e)
            arr.put(
                JSONObject().apply {
                    put("pluginId", pluginId)
                    put("capabilities", JSONArray())
                    put("events", evArr)
                    put("runtimes", JSONArray().put("android"))
                },
            )
        }
        return arr
    }

    fun dispatch(
        pluginId: String,
        event: String,
        args: JSONObject?,
        payload: ByteArray?,
        respond: (HostInvokeOutcome) -> Unit,
    ) {
        val h = handlers[Key(pluginId, event)]
            ?: return respond(
                HostInvokeOutcome.Fail(
                    ErrorCodes.UNSUPPORTED_CAPABILITY,
                    "No host handler for $pluginId.$event",
                ),
            )
        h.invoke(args, payload, respond)
    }
}
