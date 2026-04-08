package to.holepunch.bare.android

import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject
import to.holepunch.bare.kit.IPC

/**
 * Exposes [send] to JavaScript so the web layer can write framed messages to the Bare IPC channel.
 */
class BareBridge(
    private val getIpc: () -> IPC?,
) {
    @JavascriptInterface
    fun send(message: String) {
        val ipc = getIpc() ?: return
        try {
            val envelope = JSONObject(message)
            if (!envelope.has("header") || !envelope.has("type")) {
                throw IllegalArgumentException("Bridge envelope must include type and header")
            }
            val type = envelope.getInt("type").toByte()
            if (type != BareProtocol.MessageType.ENVELOPE) {
                throw IllegalArgumentException("Unsupported message type: $type")
            }
            val headerJson = envelope.getJSONObject("header").toString()
            val payloadBase64 = envelope.optString("payloadBase64", "")
            val payload = if (payloadBase64.isNotEmpty()) {
                Base64.decode(payloadBase64, Base64.DEFAULT)
            } else {
                null
            }

            val msg = BareProtocol.buildMessage(type, headerJson, payload)
            ipc.write(msg)
        } catch (e: Exception) {
            Log.e("BARE_KOTLIN", "IPC Write Error", e)
        }
    }
}
