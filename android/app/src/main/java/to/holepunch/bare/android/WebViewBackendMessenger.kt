package to.holepunch.bare.android

import android.util.Base64
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * Delivers worklet/backend messages to the WebView via [evaluateJavascript].
 */
class WebViewBackendMessenger(
    private val activity: AppCompatActivity,
    private val getWebView: () -> WebView?,
) {
    fun push(message: BareProtocol.WireMessage) {
        val payloadBase64 = if (message.payload != null) {
            Base64.encodeToString(message.payload, Base64.NO_WRAP)
        } else {
            null
        }

        activity.runOnUiThread {
            val webView = getWebView() ?: return@runOnUiThread
            val headerJson = JSONObject.quote(message.header)
            val payloadJson = if (payloadBase64 != null) JSONObject.quote(payloadBase64) else "null"
            val js =
                "window.onBackendMessage({type:${message.type.toInt()},header:JSON.parse($headerJson),payload:$payloadJson})"
            webView.evaluateJavascript(js, null)
        }
    }
}
