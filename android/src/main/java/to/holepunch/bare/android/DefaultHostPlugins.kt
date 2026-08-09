package to.holepunch.bare.android

import org.json.JSONObject

fun registerDefaultHostPlugins(registry: HostPluginRegistry) {
    registry.register("core.permissions", "permissions.requestStorage", HostPluginRegistry.Handler { _, _ ->
        // Stub: integrate with ActivityCompat.requestPermissions for production.
        HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("granted", true))
    })
}
