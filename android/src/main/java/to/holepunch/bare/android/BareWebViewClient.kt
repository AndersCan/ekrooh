package to.holepunch.bare.android

import android.content.Context
import android.util.Log
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.io.InputStream

/**
 * Serves packaged assets via [WebViewAssetLoader] and falls back to [index.html] for main-frame
 * GETs so client-side routes work on refresh.
 */
class BareWebViewClient(
    private val context: Context,
    private val assetLoader: WebViewAssetLoader,
    private val onPageLoaded: (() -> Unit)? = null,
) : WebViewClient() {
    override fun onPageFinished(view: WebView?, url: String?) {
        super.onPageFinished(view, url)
        onPageLoaded?.invoke()
    }

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

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest,
    ): WebResourceResponse? {
        val url = request.url
        if (ASSETS_HOST.equals(url.host, ignoreCase = true)) {
            val path = url.path.orEmpty()
            if (path.startsWith(ASSETS_PATH_PREFIX)) {
                return assetLoader.shouldInterceptRequest(url)
            }
            if (request.isForMainFrame &&
                request.method.equals("GET", ignoreCase = true)
            ) {
                return spaIndexResponse()
            }
        }
        return assetLoader.shouldInterceptRequest(url)
    }

    private fun spaIndexResponse(): WebResourceResponse? {
        return try {
            val stream: InputStream = context.assets.open("index.html")
            WebResourceResponse("text/html", "UTF-8", stream)
        } catch (e: Exception) {
            Log.e("BARE_KOTLIN", "SPA fallback: failed to open index.html", e)
            null
        }
    }

    companion object {
        const val ASSETS_HOST = "appassets.androidplatform.net"
        const val ASSETS_PATH_PREFIX = "/assets/"
    }
}
