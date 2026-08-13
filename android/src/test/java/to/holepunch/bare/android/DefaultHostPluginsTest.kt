package to.holepunch.bare.android

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DefaultHostPluginsTest {
    private fun dispatchSync(
        registry: HostPluginRegistry,
        pluginId: String,
        event: String,
        args: JSONObject? = null,
    ): HostPluginRegistry.HostInvokeOutcome {
        val latch = CountDownLatch(1)
        var captured: HostPluginRegistry.HostInvokeOutcome? = null
        registry.dispatch(pluginId, event, args, null) { outcome ->
            captured = outcome
            latch.countDown()
        }
        assertTrue("handler did not respond", latch.await(5, TimeUnit.SECONDS))
        return captured ?: error("no outcome captured")
    }

    @Test
    fun `request and status trivially grant storage and camera`() {
        val registry = HostPluginRegistry()
        registerDefaultHostPlugins(registry)

        for (event in listOf("permissions.request", "permissions.status")) {
            for (permission in listOf("storage", "camera")) {
                val outcome = dispatchSync(
                    registry,
                    "core.permissions",
                    event,
                    JSONObject().put("permission", permission),
                )
                assertTrue("$event $permission should be Ok", outcome is HostPluginRegistry.HostInvokeOutcome.Ok)
                val value = (outcome as HostPluginRegistry.HostInvokeOutcome.Ok).value
                assertEquals(permission, value.getString("permission"))
                assertEquals("granted", value.getString("status"))
            }
        }
    }

    @Test
    fun `capabilities list request and status`() {
        val registry = HostPluginRegistry()
        registerDefaultHostPlugins(registry)

        val json = registry.toCapabilitiesJson()
        assertEquals(1, json.length())
        val permissions = json.getJSONObject(0)
        assertEquals("core.permissions", permissions.getString("pluginId"))
        val events = permissions.getJSONArray("events")
        assertEquals("permissions.request", events.getString(0))
        assertEquals("permissions.status", events.getString(1))
    }
}
