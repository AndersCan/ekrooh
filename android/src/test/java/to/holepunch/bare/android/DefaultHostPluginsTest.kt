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

    private fun statusOf(outcome: HostPluginRegistry.HostInvokeOutcome): String {
        assertTrue("should be Ok", outcome is HostPluginRegistry.HostInvokeOutcome.Ok)
        return (outcome as HostPluginRegistry.HostInvokeOutcome.Ok).value.getString("status")
    }

    @Test
    fun `unknown permission ids are never granted`() {
        val registry = HostPluginRegistry()
        registerDefaultHostPlugins(registry)

        for (event in listOf("permissions.request", "permissions.status")) {
            for (permission in listOf("location", "camera-x", "contacts", "")) {
                val outcome = dispatchSync(
                    registry,
                    "core.permissions",
                    event,
                    JSONObject().put("permission", permission),
                )
                assertEquals("$event $permission", "unsupported", statusOf(outcome))
            }
        }
    }

    @Test
    fun `storage needs no runtime grant on this host`() {
        val registry = HostPluginRegistry()
        registerDefaultHostPlugins(registry)

        for (event in listOf("permissions.request", "permissions.status")) {
            val outcome = dispatchSync(
                registry,
                "core.permissions",
                event,
                JSONObject().put("permission", "storage"),
            )
            assertEquals("$event storage", "granted", statusOf(outcome))
        }
    }

    @Test
    fun `camera without a context is not assumed granted`() {
        val registry = HostPluginRegistry()
        registerDefaultHostPlugins(registry)

        val outcome = dispatchSync(
            registry,
            "core.permissions",
            "permissions.status",
            JSONObject().put("permission", "camera"),
        )
        // No Context in a unit test; the real grant state is unknown, so this
        // must fail closed (never a fabricated grant).
        assertEquals("denied", statusOf(outcome))
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
