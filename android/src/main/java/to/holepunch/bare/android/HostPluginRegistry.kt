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
    companion object {
        /** Host-side deadline for a handler registered without one: the
         * coordinator answers `TIMEOUT` if [Handler] has not responded by then. */
        const val DEFAULT_TIMEOUT_MS: Long = 30_000L

        /** Deadline for handlers that wait on the user (a system dialog, the
         * photo picker, the camera). Matches the worklet's media timeout. */
        const val INTERACTIVE_TIMEOUT_MS: Long = 5 * 60_000L
    }

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
    private val timeouts = ConcurrentHashMap<Key, Long>()

    /** Registers [handler] with the [DEFAULT_TIMEOUT_MS] host deadline. */
    fun register(pluginId: String, event: String, handler: Handler) {
        register(pluginId, event, DEFAULT_TIMEOUT_MS, handler)
    }

    /** Registers [handler] with its own host deadline [timeoutMs] (use
     * [INTERACTIVE_TIMEOUT_MS] for handlers that wait on the user). */
    fun register(pluginId: String, event: String, timeoutMs: Long, handler: Handler) {
        require(timeoutMs > 0) { "timeoutMs must be positive" }
        val key = Key(pluginId, event)
        timeouts[key] = timeoutMs
        handlers[key] = handler
    }

    /** The host deadline for [pluginId]/[event]: its registered timeout, or
     * [DEFAULT_TIMEOUT_MS] when no handler is registered. */
    fun timeoutFor(pluginId: String, event: String): Long =
        timeouts[Key(pluginId, event)] ?: DEFAULT_TIMEOUT_MS

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
            // Fixed string only — never reflect caller-controlled pluginId/event
            // back to page JS (would enable capability probing). Mirrors the
            // iOS host's hardening (see f863ebf).
            ?: return respond(
                HostInvokeOutcome.Fail(
                    ErrorCodes.UNSUPPORTED_CAPABILITY,
                    "No host handler for the requested capability",
                ),
            )
        h.invoke(args, payload, respond)
    }
}
