package to.holepunch.bare.android

import android.util.Log
import org.json.JSONException
import org.json.JSONObject
import to.holepunch.bare.kit.IPC
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Handles host-side IPC: capability queries and host invokes. The web layer
 * talks to the worklet over the loopback WebSocket socket, so nothing is
 * relayed to a WebView here.
 *
 * Outbound frames go through one serialized writer. `IPC.write` may accept only
 * part of a frame (or nothing) when the channel is full, so the rest is kept
 * and written when the channel turns writable again: a frame is never cut
 * short and frames never interleave, whichever thread responds.
 *
 * Every host invoke gets the deadline its handler was registered with
 * ([HostPluginRegistry.timeoutFor]). A handler that has not responded by then
 * is answered with `TIMEOUT`, and a late or second response is dropped.
 */
class HostIpcCoordinator(
    private val port: Port,
    private val hostPlugins: HostPluginRegistry,
) {
    /** The byte channel to the worklet. [IPC] in production; a fake in tests. */
    interface Port {
        /** The next chunk of bytes, or null when nothing is buffered. */
        fun read(): ByteBuffer?

        /** Writes from [buffer] (its remaining bytes). Returns how many bytes
         * were taken, which may be fewer than remaining; negative on error. */
        fun write(buffer: ByteBuffer): Int

        /** Sets (or clears, with null) the callback for "bytes to read". */
        fun readable(callback: (() -> Unit)?)

        /** Sets (or clears, with null) the callback for "room to write". */
        fun writable(callback: (() -> Unit)?)
    }

    constructor(ipc: IPC, hostPlugins: HostPluginRegistry) : this(IpcPort(ipc), hostPlugins)

    companion object {
        private const val MAX_FIELD_BYTES = 256

        private val sharedTimer: ScheduledExecutorService by lazy {
            ScheduledThreadPoolExecutor(1) { r ->
                Thread(r, "bare-host-deadlines").apply { isDaemon = true }
            }.apply { removeOnCancelPolicy = true }
        }
    }

    private val decoder = FrameDecoder { header ->
        // A complete frame with an unknown version or type: answer it (keyed to
        // its requestId when the header is readable) instead of leaving the
        // worklet to time out.
        writeError(header, ErrorCodes.FRAME_INVALID, "Unsupported frame version or type")
    }

    private val outboundLock = Any()
    private val outbound = ArrayDeque<ByteBuffer>()
    private var waitingForWritable = false

    @Volatile
    private var stopped = false
    private val deadlines: MutableSet<ScheduledFuture<*>> = ConcurrentHashMap.newKeySet()

    fun start() {
        port.readable {
            try {
                val data = port.read() ?: return@readable
                val raw = ByteArray(data.remaining()).also { data.get(it) }
                val messages = decoder.push(raw)
                // A framing violation marks the decoder inert but still returns the
                // frames decoded before it; drop the corrupt byte stream and resync.
                if (decoder.error != null) {
                    if (BuildConfig.DEBUG) Log.e("BARE_KOTLIN", "IPC frame decoder desynced; resetting")
                    decoder.clear()
                }
                for (message in messages) {
                    dispatch(message)
                }
            } catch (e: Exception) {
                // The readable loop must survive any thrown frame so a single
                // malformed/oversized envelope never permanently stalls all host
                // invokes. Logging is debug-only (URLs/tokens may transit here).
                if (BuildConfig.DEBUG) Log.e("BARE_KOTLIN", "Error in readable callback", e)
            }
        }
    }

    /** Stops reading, drops queued frames and cancels pending deadlines.
     * Responses that arrive afterwards are ignored. Call before closing the IPC. */
    fun stop() {
        stopped = true
        // Under the same lock as every write and writable() call, so the
        // native IPC never sees callback changes and writes concurrently.
        synchronized(outboundLock) {
            port.readable(null)
            outbound.clear()
            if (waitingForWritable) {
                waitingForWritable = false
                port.writable(null)
            }
        }
        for (deadline in deadlines) deadline.cancel(false)
        deadlines.clear()
    }

    private fun dispatch(message: BareProtocol.WireMessage) {
        val headerObj = try {
            JSONObject(message.header)
        } catch (e: JSONException) {
            // Header was not valid JSON: answer with an error frame so the
            // web layer never waits on an unanswered correlation id, then
            // re-arm the readable loop and continue.
            writeError(null, ErrorCodes.FRAME_INVALID, "Invalid envelope header")
            return
        }
        when (headerObj.optString("type")) {
            "HOST_CAPABILITIES_QUERY" -> {
                val reqId = headerObj.optString("requestId")
                if (!validField(reqId)) {
                    writeError(null, ErrorCodes.FRAME_INVALID, "Missing or invalid requestId")
                    return
                }
                val resp = JSONObject().apply {
                    put("type", "HOST_CAPABILITIES_RESPONSE")
                    put("requestId", reqId)
                    put("capabilities", hostPlugins.toCapabilitiesJson())
                }
                send(resp.toString())
            }
            "HOST_INVOKE_REQUEST" -> {
                val reqId = headerObj.optString("requestId")
                val pluginId = headerObj.optString("pluginId")
                val event = headerObj.optString("event")
                if (!validField(reqId) || !validField(pluginId) || !validField(event)) {
                    // Echo the original header (if any) so a correlated error
                    // frame is returned; never let one bad frame stall the loop.
                    writeError(message.header, ErrorCodes.FRAME_INVALID, "Malformed HOST_INVOKE_REQUEST")
                    return
                }
                invoke(reqId, pluginId, event, headerObj.optJSONObject("args"), message.payload)
            }
            else -> {
                writeError(message.header, ErrorCodes.FRAME_INVALID, "Unknown envelope type")
                return
            }
        }
    }

    private fun invoke(
        reqId: String,
        pluginId: String,
        event: String,
        args: JSONObject?,
        payload: ByteArray?,
    ) {
        val answered = AtomicBoolean(false)
        var deadline: ScheduledFuture<*>? = null

        fun answer(outcome: HostPluginRegistry.HostInvokeOutcome) {
            // Exactly one response per request: the handler's first answer or
            // the deadline, whichever comes first.
            if (!answered.compareAndSet(false, true)) return
            deadline?.let {
                it.cancel(false)
                deadlines.remove(it)
            }
            if (stopped) return
            writeInvokeResponse(reqId, pluginId, event, outcome)
        }

        val timeoutMs = hostPlugins.timeoutFor(pluginId, event)
        val scheduled = sharedTimer.schedule(
            {
                answer(
                    HostPluginRegistry.HostInvokeOutcome.Fail(
                        ErrorCodes.TIMEOUT,
                        "Host handler did not respond within ${timeoutMs}ms",
                    ),
                )
            },
            timeoutMs,
            TimeUnit.MILLISECONDS,
        )
        deadline = scheduled
        deadlines.add(scheduled)
        if (answered.get()) {
            scheduled.cancel(false)
            deadlines.remove(scheduled)
        }

        try {
            hostPlugins.dispatch(pluginId, event, args, payload) { outcome -> answer(outcome) }
        } catch (e: Exception) {
            // A throwing handler still gets its request answered.
            if (BuildConfig.DEBUG) Log.e("BARE_KOTLIN", "Host handler threw", e)
            answer(HostPluginRegistry.HostInvokeOutcome.Fail(ErrorCodes.HOST_ERROR, "Host handler failed"))
        }
    }

    private fun writeInvokeResponse(
        reqId: String,
        pluginId: String,
        event: String,
        outcome: HostPluginRegistry.HostInvokeOutcome,
    ) {
        fun header(outcome: HostPluginRegistry.HostInvokeOutcome) = JSONObject().apply {
            put("type", "HOST_INVOKE_RESPONSE")
            put("requestId", reqId)
            put("pluginId", pluginId)
            put("event", event)
            when (outcome) {
                is HostPluginRegistry.HostInvokeOutcome.Ok -> put("result", outcome.value)
                is HostPluginRegistry.HostInvokeOutcome.Fail -> put(
                    "error",
                    JSONObject().apply {
                        put("code", outcome.code)
                        put("message", outcome.message)
                    },
                )
            }
        }.toString()

        val text = header(outcome)
        if (text.toByteArray(Charsets.UTF_8).size > BareProtocol.MAX_HEADER_BYTES) {
            // A result too large for one header still gets a correlated answer.
            send(
                header(
                    HostPluginRegistry.HostInvokeOutcome.Fail(
                        ErrorCodes.FRAME_TOO_LARGE,
                        "Host response exceeds the header limit",
                    ),
                ),
            )
            return
        }
        send(text)
    }

    private fun writeError(requestHeader: String?, code: String, message: String) {
        try {
            val header = requestHeader ?: "{}"
            val err = BareProtocol.buildErrorResponse(
                header,
                code,
                message,
                "HOST_INVOKE_RESPONSE",
            )
            send(err.header)
        } catch (e: Exception) {
            if (BuildConfig.DEBUG) Log.e("BARE_KOTLIN", "Failed to write error frame", e)
        }
    }

    private fun send(headerJson: String) {
        val frame = try {
            BareProtocol.buildMessage(BareProtocol.MessageType.ENVELOPE, headerJson, null)
        } catch (e: Exception) {
            if (BuildConfig.DEBUG) Log.e("BARE_KOTLIN", "Failed to build frame", e)
            return
        }
        synchronized(outboundLock) {
            if (stopped) return
            outbound.addLast(frame)
            if (!waitingForWritable) drainLocked()
        }
    }

    /** Writes queued frames in order until the queue is empty or the channel
     * is full. A partial write keeps the unwritten tail at the head of the
     * queue and waits for the channel to turn writable. */
    private fun drainLocked() {
        while (true) {
            val head = outbound.peekFirst() ?: break
            val written = try {
                port.write(head)
            } catch (e: Exception) {
                -1
            }
            if (written < 0) {
                // The channel is gone; nothing queued can be delivered.
                if (BuildConfig.DEBUG) Log.e("BARE_KOTLIN", "IPC write failed; dropping queued frames")
                outbound.clear()
                break
            }
            if (written >= head.remaining()) {
                outbound.removeFirst()
                continue
            }
            // Keep only the unwritten tail, starting at offset 0, so the next
            // write sends exactly the bytes still owed.
            head.position(head.position() + written)
            outbound.removeFirst()
            outbound.addFirst(head.slice())
            if (!waitingForWritable) {
                waitingForWritable = true
                port.writable { onWritable() }
            }
            return
        }
        if (waitingForWritable) {
            waitingForWritable = false
            port.writable(null)
        }
    }

    private fun onWritable() {
        synchronized(outboundLock) {
            if (stopped) return
            drainLocked()
        }
    }

    private fun validField(s: String): Boolean =
        s.isNotEmpty() && s.toByteArray(Charsets.UTF_8).size <= MAX_FIELD_BYTES
}

/** [HostIpcCoordinator.Port] over Bare Kit's [IPC]. */
private class IpcPort(private val ipc: IPC) : HostIpcCoordinator.Port {
    override fun read(): ByteBuffer? = ipc.read()

    // IPC.write sends `limit()` bytes from the start of the buffer, so pass a
    // view that starts at the buffer's position.
    override fun write(buffer: ByteBuffer): Int = ipc.write(buffer.slice())

    override fun readable(callback: (() -> Unit)?) {
        ipc.readable(callback?.let { cb -> IPC.PollCallback { cb() } })
    }

    override fun writable(callback: (() -> Unit)?) {
        ipc.writable(callback?.let { cb -> IPC.PollCallback { cb() } })
    }
}
