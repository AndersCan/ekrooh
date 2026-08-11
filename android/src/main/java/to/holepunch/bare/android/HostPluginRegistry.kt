package to.holepunch.bare.android

import org.json.JSONArray
import org.json.JSONObject

/**
 * Registers host-side invoke handlers for events delegated from the Bare worklet over IPC.
 */
class HostPluginRegistry {
    data class Key(val pluginId: String, val event: String)

    fun interface Handler {
        fun invoke(args: JSONObject?, payload: ByteArray?): HostInvokeOutcome
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

    fun dispatch(pluginId: String, event: String, args: JSONObject?, payload: ByteArray?): HostInvokeOutcome {
        val h = handlers[Key(pluginId, event)]
            ?: return HostInvokeOutcome.Fail(
                ErrorCodes.UNSUPPORTED_CAPABILITY,
                "No host handler for $pluginId.$event",
            )
        return h.invoke(args, payload)
    }
}
