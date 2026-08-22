package to.holepunch.bare.android

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

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

    // ConcurrentHashMap: register() runs on the host app main thread while
    // dispatch()/toCapabilitiesJson() run on Bare Kit IPC callback threads, so
    // the shared map must be safe for concurrent mutation + iteration. Iteration
    // is weakly consistent (never throws ConcurrentModificationException) and
    // toCapabilitiesJson snapshots into a private map for a consistent view.
    private val handlers = ConcurrentHashMap<Key, Handler>()

    fun register(pluginId: String, event: String, handler: Handler) {
        handlers[Key(pluginId, event)] = handler
    }

    fun toCapabilitiesJson(): JSONArray {
        val snapshot = LinkedHashMap(handlers)
        val byPlugin = mutableMapOf<String, MutableSet<String>>()
        for ((key, _) in snapshot) {
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
