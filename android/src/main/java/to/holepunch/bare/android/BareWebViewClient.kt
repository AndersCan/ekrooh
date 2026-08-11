package to.holepunch.bare.android

import android.util.Log
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Logs WebView resource errors. The web app is served by the worklet's
 * loopback HTTP server, so this client performs no asset interception.
 */
class BareWebViewClient : WebViewClient() {
    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?,
    ) {
        super.onReceivedError(view, request, error)
        Log.e(
            "BARE_KOTLIN",
            "WebView error ${error?.errorCode} ${error?.description} for ${request?.url}",
        )
    }

    override fun onReceivedHttpError(
        view: WebView?,
        request: WebResourceRequest?,
        errorResponse: WebResourceResponse?,
    ) {
        super.onReceivedHttpError(view, request, errorResponse)
        Log.e(
            "BARE_KOTLIN",
            "WebView http error ${errorResponse?.statusCode} for ${request?.url}",
        )
    }
}
