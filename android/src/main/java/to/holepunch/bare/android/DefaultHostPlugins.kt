package to.holepunch.bare.android

import org.json.JSONObject

fun registerDefaultHostPlugins(registry: HostPluginRegistry) {
    fun grant(permission: String): HostPluginRegistry.HostInvokeOutcome =
        HostPluginRegistry.HostInvokeOutcome.Ok(
            JSONObject().put("permission", permission).put("status", "granted"),
        )

    // Storage and camera trivially grant on Android for the reference app.
    registry.register("core.permissions", "permissions.request") { args, _, respond ->
        respond(grant(args?.optString("permission") ?: "storage"))
    }
    registry.register("core.permissions", "permissions.status") { args, _, respond ->
        respond(grant(args?.optString("permission") ?: "storage"))
    }
}
