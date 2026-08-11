package to.holepunch.bare.android

import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewCompat
import to.holepunch.bare.kit.IPC
import java.nio.ByteBuffer

/**
 * Carries framed messages between the WebView and the Bare IPC channel over a
 * WebMessageChannel (via the AndroidX compat layer), replacing the old
 * JSON+base64 `@JavascriptInterface` bridge.
 *
 * - WebView → worklet: frames from the page arrive on the port and are written
 *   to the IPC channel as raw bytes.
 * - worklet → WebView: [push] relays the original frame bytes back over the
 *   port — no re-parse, no re-serialization.
 *
 * On API 34+ frames travel as raw array-buffer bytes. Older WebViews carry the
 * same bytes base64-encoded in a string (the JS transport decodes them), so the
 * wire format is identical on every device.
 */
class BarePortMessenger(
    private val getIpc: () -> IPC?,
) {
    companion object {
        private const val SENTINEL_BINARY = "__less_bare_port__:binary"
        private const val SENTINEL_BASE64 = "__less_bare_port__:base64"
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var port: WebMessagePortCompat? = null

    /** Creates the channel, wires the host port, and hands the page port to the WebView. */
    fun attachTo(webView: WebView) {
        val ports = WebViewCompat.createWebMessageChannel(webView)
        ports[1].setWebMessageCallback(object : WebMessagePortCompat.WebMessageCallbackCompat() {
            override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat) {
                onMessage(message)
            }
        })
        this.port = ports[1]
        val binary = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        WebViewCompat.postWebMessage(
            webView,
            WebMessageCompat(if (binary) SENTINEL_BINARY else SENTINEL_BASE64, arrayOf(ports[0])),
            Uri.parse("*"),
        )
    }

    /** Relays a worklet → web frame. Safe to call from any thread. */
    fun push(bytes: ByteArray) {
        mainHandler.post {
            val target = port ?: return@post
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                target.postMessage(WebMessageCompat(bytes))
            } else {
                target.postMessage(WebMessageCompat(Base64.encodeToString(bytes, Base64.NO_WRAP)))
            }
        }
    }

    private fun onMessage(message: WebMessageCompat) {
        val bytes: ByteArray? = when (message.type) {
            WebMessageCompat.TYPE_ARRAY_BUFFER -> message.arrayBuffer
            else -> decodeBase64(message.data)
        }
        onFrame(bytes)
    }

    private fun decodeBase64(data: String): ByteArray? {
        return try {
            Base64.decode(data, Base64.DEFAULT)
        } catch (e: Exception) {
            null
        }
    }

    private fun onFrame(bytes: ByteArray?) {
        if (bytes == null || bytes.isEmpty()) return

        if (bytes.size > BareProtocol.MAX_FRAME_BYTES) {
            val parsed = BareProtocol.parseMessage(ByteBuffer.wrap(bytes))
            val error = BareProtocol.buildErrorResponse(
                parsed?.header ?: "{}",
                ErrorCodes.FRAME_TOO_LARGE,
                "Frame exceeds maximum size",
            )
            push(frameBytes(error))
            return
        }

        val ipc = getIpc() ?: return
        ipc.write(ByteBuffer.wrap(bytes))
    }

    private fun frameBytes(message: BareProtocol.WireMessage): ByteArray {
        val buffer = BareProtocol.buildMessage(message.type, message.header, message.payload)
        return ByteArray(buffer.remaining()).also { buffer.get(it) }
    }
}
