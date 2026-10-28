package to.holepunch.bare.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.util.Log
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.net.URI

/**
 * Logs WebView resource errors and confines top-level navigation to the
 * worklet's loopback origin. The web app is served by the worklet's loopback
 * HTTP server, so this client performs no asset interception.
 *
 * Set [allowedOrigin] (`http://127.0.0.1:<port>`, from the handoff) before
 * loading the page. Any other main-frame navigation is cancelled; http(s)
 * links open in the system browser instead of inside the trusted WebView.
 * Mirrors the iOS reference host's navigation delegate.
 */
class BareWebViewClient : WebViewClient() {
    /** The loopback origin the WebView may navigate within. Until it is set,
     * every main-frame navigation the page starts is refused. */
    @Volatile
    var allowedOrigin: String? = null

    override fun shouldOverrideUrlLoading(
        view: WebView?,
        request: WebResourceRequest?,
    ): Boolean {
        if (request == null || !request.isForMainFrame) return false
        val url = request.url.toString()
        if (isAllowedNavigation(url, allowedOrigin)) return false
        if (isExternalWebUrl(url)) {
            try {
                view?.context?.startActivity(
                    Intent(Intent.ACTION_VIEW, request.url)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (e: ActivityNotFoundException) {
                if (BuildConfig.DEBUG) Log.w("BARE_KOTLIN", "No browser for $url")
            }
        }
        return true
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?,
    ) {
        super.onReceivedError(view, request, error)
        if (BuildConfig.DEBUG) {
            Log.e(
                "BARE_KOTLIN",
                "WebView error ${error?.errorCode} ${error?.description} for ${request?.url}",
            )
        }
    }

    override fun onReceivedHttpError(
        view: WebView?,
        request: WebResourceRequest?,
        errorResponse: WebResourceResponse?,
    ) {
        super.onReceivedHttpError(view, request, errorResponse)
        if (BuildConfig.DEBUG) {
            Log.e(
                "BARE_KOTLIN",
                "WebView http error ${errorResponse?.statusCode} for ${request?.url}",
            )
        }
    }

    companion object {
        /** Whether a main-frame navigation to [url] stays on [allowedOrigin]
         * (same scheme, host and port). False when no origin is set yet. */
        @JvmStatic
        fun isAllowedNavigation(url: String, allowedOrigin: String?): Boolean {
            if (allowedOrigin == null) return false
            val target = parse(url) ?: return false
            val allowed = parse(allowedOrigin) ?: return false
            return target.scheme.equals(allowed.scheme, ignoreCase = true) &&
                target.host.equals(allowed.host, ignoreCase = true) &&
                effectivePort(target) == effectivePort(allowed)
        }

        /** Whether [url] is an http(s) link the system browser can open. */
        @JvmStatic
        fun isExternalWebUrl(url: String): Boolean {
            val scheme = parse(url)?.scheme?.lowercase() ?: return false
            return scheme == "http" || scheme == "https"
        }

        private fun parse(url: String): URI? =
            try {
                URI(url).takeIf { it.scheme != null && it.host != null }
            } catch (e: Exception) {
                null
            }

        private fun effectivePort(uri: URI): Int =
            when {
                uri.port != -1 -> uri.port
                uri.scheme.equals("https", ignoreCase = true) -> 443
                else -> 80
            }
    }
}
