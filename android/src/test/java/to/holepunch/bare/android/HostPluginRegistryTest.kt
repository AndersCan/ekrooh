package to.holepunch.bare.android

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HostPluginRegistryTest {
    private fun ok(): HostPluginRegistry.HostInvokeOutcome =
        HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("granted", true))

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
    fun `dispatches to a registered handler`() {
        val registry = HostPluginRegistry()
        registry.register("core.permissions", "permissions.requestStorage") { _, _, respond ->
            respond(ok())
        }
        val outcome =
            dispatchSync(registry, "core.permissions", "permissions.requestStorage", JSONObject())
        assertTrue(outcome is HostPluginRegistry.HostInvokeOutcome.Ok)
        assertEquals(
            true,
            (outcome as HostPluginRegistry.HostInvokeOutcome.Ok).value.getBoolean("granted"),
        )
    }

    @Test
    fun `returns UNSUPPORTED_CAPABILITY for unregistered events`() {
        val registry = HostPluginRegistry()
        val outcome = dispatchSync(registry, "core.health", "health.ping")
        assertTrue(outcome is HostPluginRegistry.HostInvokeOutcome.Fail)
        val fail = outcome as HostPluginRegistry.HostInvokeOutcome.Fail
        assertEquals("UNSUPPORTED_CAPABILITY", fail.code)
        assertTrue(fail.message.contains("core.health.health.ping"))
    }

    @Test
    fun `groups capability rows by plugin and sorts events`() {
        val registry = HostPluginRegistry()
        registry.register("core.permissions", "permissions.requestStorage") { _, _, respond -> respond(ok()) }
        registry.register("core.permissions", "permissions.requestOther") { _, _, respond -> respond(ok()) }
        registry.register("core.health", "health.ping") { _, _, respond -> respond(ok()) }

        val json = registry.toCapabilitiesJson()
        assertEquals(2, json.length())

        fun row(pluginId: String): JSONObject {
            for (i in 0 until json.length()) {
                val candidate = json.getJSONObject(i)
                if (candidate.getString("pluginId") == pluginId) return candidate
            }
            throw AssertionError("missing row for $pluginId")
        }

        val permissions = row("core.permissions")
        assertEquals("android", permissions.getJSONArray("runtimes").getString(0))
        val events = permissions.getJSONArray("events")
        assertEquals("permissions.requestOther", events.getString(0))
        assertEquals("permissions.requestStorage", events.getString(1))

        assertEquals(
            JSONArray().put("health.ping").toString(),
            row("core.health").getJSONArray("events").toString(),
        )
    }
}
