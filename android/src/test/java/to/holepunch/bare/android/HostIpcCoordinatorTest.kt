package to.holepunch.bare.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class HostIpcCoordinatorTest {
    /** A channel that accepts at most [chunk] bytes per write (0 = channel
     * full) and records what it took. */
    private class FakePort(@Volatile var chunk: Int = Int.MAX_VALUE) : HostIpcCoordinator.Port {
        val inbound = ArrayDeque<ByteBuffer>()
        val written = ByteArrayOutputStream()
        var readableCb: (() -> Unit)? = null
        @Volatile var writableCb: (() -> Unit)? = null
        var writes = 0

        override fun read(): ByteBuffer? = synchronized(inbound) { inbound.pollFirst() }

        @Synchronized
        override fun write(buffer: ByteBuffer): Int {
            writes++
            val n = minOf(chunk, buffer.remaining())
            val view = buffer.duplicate()
            val bytes = ByteArray(n)
            view.get(bytes)
            written.write(bytes)
            return n
        }

        override fun readable(callback: (() -> Unit)?) {
            readableCb = callback
        }

        override fun writable(callback: (() -> Unit)?) {
            writableCb = callback
        }

        fun deliver(bytes: ByteArray) {
            synchronized(inbound) { inbound.addLast(ByteBuffer.wrap(bytes)) }
            readableCb?.invoke()
        }

        @Synchronized
        fun frames(): List<JSONObject> {
            val decoded = FrameDecoder().push(written.toByteArray())
            return decoded.map { JSONObject(it.header) }
        }
    }

    private fun frame(header: JSONObject, version: Byte = BareProtocol.VERSION): ByteArray {
        val buffer = BareProtocol.buildMessage(BareProtocol.MessageType.ENVELOPE, header.toString(), null)
        return ByteArray(buffer.remaining()).also { buffer.get(it) }.also { it[0] = version }
    }

    private fun invoke(id: String, event: String = "health.ping") = JSONObject()
        .put("type", "HOST_INVOKE_REQUEST")
        .put("requestId", id)
        .put("pluginId", "test")
        .put("event", event)

    private fun waitUntil(timeoutMs: Long = 5_000, check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (check()) return
            Thread.sleep(10)
        }
        throw AssertionError("condition not met in ${timeoutMs}ms")
    }

    @Test
    fun `a partial write keeps the tail and finishes it when the channel is writable`() {
        val port = FakePort(chunk = 5)
        val registry = HostPluginRegistry()
        registry.register("test", "health.ping") { _, _, respond ->
            respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("pong", "x".repeat(200))))
        }
        HostIpcCoordinator(port, registry).start()

        port.deliver(frame(invoke("a")) + frame(invoke("b")))
        // Only the first 5 bytes went out; the rest waits for writability.
        assertEquals(1, port.writes)
        assertTrue(port.writableCb != null)

        port.chunk = 7
        var guard = 0
        while (port.writableCb != null && guard++ < 10_000) port.writableCb?.invoke()

        val frames = port.frames()
        assertEquals(listOf("a", "b"), frames.map { it.getString("requestId") })
        assertEquals("x".repeat(200), frames[0].getJSONObject("result").getString("pong"))
    }

    @Test
    fun `a full channel writes nothing until it turns writable`() {
        val port = FakePort(chunk = 0)
        val registry = HostPluginRegistry()
        registry.register("test", "health.ping") { _, _, respond ->
            respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject()))
        }
        HostIpcCoordinator(port, registry).start()
        port.deliver(frame(invoke("a")))
        assertEquals(0, port.written.size())

        port.chunk = Int.MAX_VALUE
        port.writableCb!!.invoke()
        assertEquals(listOf("a"), port.frames().map { it.getString("requestId") })
        assertEquals(null, port.writableCb)
    }

    @Test
    fun `responses from many threads never interleave`() {
        val port = FakePort(chunk = 3)
        val registry = HostPluginRegistry()
        registry.register("test", "health.ping") { _, _, respond ->
            Thread { respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("v", "y".repeat(50)))) }.start()
        }
        HostIpcCoordinator(port, registry).start()
        val ids = (1..20).map { "r$it" }
        for (id in ids) port.deliver(frame(invoke(id)))
        val pump = Thread {
            val end = System.currentTimeMillis() + 5_000
            while (System.currentTimeMillis() < end) {
                port.writableCb?.invoke()
                if (port.frames().size == ids.size) break
            }
        }
        pump.start()
        pump.join()
        assertEquals(ids.toSet(), port.frames().map { it.getString("requestId") }.toSet())
    }

    @Test
    fun `a handler that never responds is answered with TIMEOUT once`() {
        val port = FakePort()
        val registry = HostPluginRegistry()
        var late: ((HostPluginRegistry.HostInvokeOutcome) -> Unit)? = null
        val captured = CountDownLatch(1)
        registry.register("test", "slow", 50) { _, _, respond ->
            late = respond
            captured.countDown()
        }
        HostIpcCoordinator(port, registry).start()
        port.deliver(frame(invoke("t", "slow")))
        assertTrue(captured.await(1, TimeUnit.SECONDS))
        waitUntil { port.frames().isNotEmpty() }
        val error = port.frames().single().getJSONObject("error")
        assertEquals(ErrorCodes.TIMEOUT, error.getString("code"))

        // A late answer after the deadline is dropped.
        late!!(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject()))
        Thread.sleep(50)
        assertEquals(1, port.frames().size)
    }

    @Test
    fun `handlers get their registered deadline and a responding handler is answered once`() {
        val registry = HostPluginRegistry()
        registry.register("a", "b") { _, _, _ -> }
        registry.register("a", "c", HostPluginRegistry.INTERACTIVE_TIMEOUT_MS) { _, _, _ -> }
        assertEquals(HostPluginRegistry.DEFAULT_TIMEOUT_MS, registry.timeoutFor("a", "b"))
        assertEquals(HostPluginRegistry.INTERACTIVE_TIMEOUT_MS, registry.timeoutFor("a", "c"))
        assertEquals(HostPluginRegistry.DEFAULT_TIMEOUT_MS, registry.timeoutFor("x", "y"))

        val port = FakePort()
        registry.register("test", "twice") { _, _, respond ->
            respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("n", 1)))
            respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("n", 2)))
        }
        HostIpcCoordinator(port, registry).start()
        port.deliver(frame(invoke("once", "twice")))
        assertEquals(1, port.frames().size)
        assertEquals(1, port.frames()[0].getJSONObject("result").getInt("n"))
    }

    @Test
    fun `a throwing handler is answered with HOST_ERROR`() {
        val port = FakePort()
        val registry = HostPluginRegistry()
        registry.register("test", "boom") { _, _, _ -> throw IllegalStateException("boom") }
        HostIpcCoordinator(port, registry).start()
        port.deliver(frame(invoke("e", "boom")))
        val frame = port.frames().single()
        assertEquals("e", frame.getString("requestId"))
        assertEquals(ErrorCodes.HOST_ERROR, frame.getJSONObject("error").getString("code"))
    }

    @Test
    fun `a frame with an unknown version is answered with FRAME_INVALID`() {
        val port = FakePort()
        HostIpcCoordinator(port, HostPluginRegistry()).start()
        port.deliver(frame(invoke("v"), version = 9))
        val frame = port.frames().single()
        assertEquals("v", frame.getString("requestId"))
        assertEquals(ErrorCodes.FRAME_INVALID, frame.getJSONObject("error").getString("code"))
    }

    @Test
    fun `stop drops queued frames and ignores later responses`() {
        val port = FakePort(chunk = 0)
        val registry = HostPluginRegistry()
        var later: ((HostPluginRegistry.HostInvokeOutcome) -> Unit)? = null
        registry.register("test", "health.ping") { _, _, respond -> later = respond }
        val coordinator = HostIpcCoordinator(port, registry)
        coordinator.start()
        port.deliver(frame(invoke("s")))
        coordinator.stop()
        port.chunk = Int.MAX_VALUE
        later!!(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject()))
        assertEquals(0, port.written.size())
        assertEquals(null, port.readableCb)
    }

    @Test
    fun `field limits count UTF-8 bytes, not characters`() {
        val port = FakePort()
        val registry = HostPluginRegistry()
        registry.register("test", "health.ping") { _, _, respond ->
            respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject()))
        }
        HostIpcCoordinator(port, registry).start()
        // 100 characters, 300 bytes: over the 256-byte field limit.
        port.deliver(frame(invoke("\u20ac".repeat(100))))
        val frame = port.frames().single()
        assertEquals(ErrorCodes.FRAME_INVALID, frame.getJSONObject("error").getString("code"))
    }
}
