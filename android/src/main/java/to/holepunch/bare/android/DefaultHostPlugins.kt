package to.holepunch.bare.android

import org.json.JSONObject

fun registerDefaultHostPlugins(registry: HostPluginRegistry) {
    registry.register("core.permissions", "permissions.requestStorage") { _, _, respond ->
        // Stub: integrate with ActivityCompat.requestPermissions for production.
        respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("granted", true)))
    }
}
