package to.holepunch.bare.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.net.URI

/**
 * Logs WebView resource errors and confines top-level navigation to the
 * worklet's loopback origin. The web app is served by the worklet's loopback
 * HTTP server, so this client performs no asset interception.
 *
 * Set [allowedOrigin] (`http://127.0.0.1:<port>`, from the handoff) before
 * loading the page. Any other main-frame navigation is cancelled:
 * - GET navigations are refused in [shouldOverrideUrlLoading]. An http(s) link
 *   the user tapped opens in the system browser; one started without a user
 *   gesture (a meta refresh, a script redirect) is only cancelled.
 * - POST navigations (a form submit), which never reach
 *   [shouldOverrideUrlLoading], are answered with an empty 403 in
 *   [shouldInterceptRequest] and the page goes back.
 *
 * Mirrors the iOS reference host's navigation delegate. The class is open so a
 * host can add callbacks (e.g. `onPageFinished`); overrides must call `super`.
 */
open class BareWebViewClient : WebViewClient() {
    /** The loopback origin the WebView may navigate within. Until it is set,
     * every main-frame navigation the page starts is refused. */
    @Volatile
    var allowedOrigin: String? = null

    /** Called when the renderer process died or was killed. The WebView is
     * unusable: the host must remove and destroy it (and may create a new
     * one). When null, the default applies and the app process is killed. */
    @Volatile
    var onRenderProcessGone: ((WebView) -> Unit)? = null

    override fun shouldOverrideUrlLoading(
        view: WebView?,
        request: WebResourceRequest?,
    ): Boolean {
        if (request == null || !request.isForMainFrame) return false
        val url = request.url.toString()
        if (isAllowedNavigation(url, allowedOrigin)) return false
        if (shouldOpenExternally(url, request.hasGesture())) {
            try {
                view?.context?.startActivity(
                    Intent(Intent.ACTION_VIEW, request.url)
                        .addCategory(Intent.CATEGORY_BROWSABLE)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (e: ActivityNotFoundException) {
                if (BuildConfig.DEBUG) Log.w("BARE_KOTLIN", "No browser for $url")
            }
        }
        return true
    }

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?,
    ): WebResourceResponse? {
        if (request != null &&
            shouldBlockMainFrameRequest(request.url.toString(), allowedOrigin, request.isForMainFrame)
        ) {
            // A main-frame load that skipped shouldOverrideUrlLoading (POST).
            return WebResourceResponse(
                "text/plain",
                "utf-8",
                403,
                "Forbidden",
                mapOf("Cache-Control" to "no-store"),
                ByteArrayInputStream(ByteArray(0)),
            )
        }
        return super.shouldInterceptRequest(view, request)
    }

    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
        super.onPageStarted(view, url, favicon)
        if (view != null && url != null && shouldBlockMainFrameRequest(url, allowedOrigin, true)) {
            // A document from another origin committed in the trusted WebView:
            // stop it and return to the app page.
            view.stopLoading()
            if (view.canGoBack()) view.goBack()
        }
    }

    override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
        val handler = onRenderProcessGone ?: return super.onRenderProcessGone(view, detail)
        if (view != null) handler(view)
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
                effectivePort(target) == effectivePort(allowed) &&
                target.rawUserInfo == null
        }

        /** Whether [url] is an http(s) link the system browser can open. */
        @JvmStatic
        fun isExternalWebUrl(url: String): Boolean {
            val scheme = parse(url)?.scheme?.lowercase() ?: return false
            return scheme == "http" || scheme == "https"
        }

        /** Whether a refused main-frame navigation to [url] goes to the system
         * browser: only an http(s) URL, and only when the user started it. */
        @JvmStatic
        fun shouldOpenExternally(url: String, hasGesture: Boolean): Boolean =
            hasGesture && isExternalWebUrl(url)

        /** Whether a main-frame request for [url] must be refused once an
         * origin is set. Non-network URLs (`about:`, `data:`) never reach the
         * network and are left to the WebView. Before [allowedOrigin] is set
         * nothing is blocked here, so a host's own first `loadUrl` still works. */
        @JvmStatic
        fun shouldBlockMainFrameRequest(
            url: String,
            allowedOrigin: String?,
            isForMainFrame: Boolean,
        ): Boolean {
            if (!isForMainFrame || allowedOrigin == null) return false
            val scheme = url.substringBefore(':', "").lowercase()
            if (scheme != "http" && scheme != "https") return false
            return !isAllowedNavigation(url, allowedOrigin)
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
