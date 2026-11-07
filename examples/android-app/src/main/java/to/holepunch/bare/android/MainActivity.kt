package to.holepunch.bare.android

import android.Manifest
import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import to.holepunch.bare.android.app.R

/**
 * The reference shell's only screen: a WebView on the worklet's loopback page.
 * The worklet and host plugins live in [ReferenceHost] (process-wide); this
 * Activity attaches to it and is the UI the host plugins launch from.
 */
class MainActivity : AppCompatActivity(), ReferenceHost.Ui {
    private lateinit var host: ReferenceHost
    private lateinit var webView: WebView
    private var bootstrapScript: ScriptHandler? = null
    private var webViewReleased = false

    // Activity Result launchers, registered in onCreate (before the Activity
    // is started) per the Activity Result API contract. Results route back to
    // the host, so a call survives this Activity being recreated.
    private lateinit var permissionLauncher: ActivityResultLauncher<String>
    private lateinit var cameraPermissionLauncher: ActivityResultLauncher<String>
    private lateinit var pickLauncher: ActivityResultLauncher<PickVisualMediaRequest>
    private lateinit var imageCaptureLauncher: ActivityResultLauncher<Uri>
    private lateinit var videoCaptureLauncher: ActivityResultLauncher<Uri>

    private val webViewClient = object : BareWebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            // The bootstrap script is for the first document only: once it ran
            // (and the page exchanged the nonce for the session cookie), later
            // documents in this WebView (a reload, an in-app navigation, a
            // mounted file opened as a page) do not get the nonce. A reload
            // logs in with the surviving session cookie. Only the app page
            // counts: a late error page finishing must not remove it early.
            val origin = allowedOrigin ?: return
            if (url == null || !BareWebViewClient.isAllowedNavigation(url, origin)) return
            val script = bootstrapScript ?: return
            script.remove()
            bootstrapScript = null
            host.markBootstrapDelivered()
            // Drop an earlier error page from history so Back leaves the app.
            view?.clearHistory()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        host = (application as BareApplication).host

        permissionLauncher =
            registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
                host.onPermissionResult(granted)
            }
        cameraPermissionLauncher =
            registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
                host.onCameraPermissionResult(granted)
            }
        pickLauncher =
            registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
                host.onPickResult(uri)
            }
        imageCaptureLauncher =
            registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
                host.onCaptureResult(ok)
            }
        // CaptureVideo reports success as a Boolean. (TakeVideo's thumbnail is
        // null on most camera apps when EXTRA_OUTPUT is set, even on success.)
        videoCaptureLauncher =
            registerForActivityResult(ActivityResultContracts.CaptureVideo()) { ok ->
                host.onCaptureResult(ok)
            }

        webView = findViewById(R.id.webview)
        configureWebView(webView)

        host.attach(this)
        host.whenReady(this) { handoff -> if (handoff != null) load(handoff) else showError(HANDOFF_FAILED) }

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            },
        )
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(view: WebView) {
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        // The page is served over loopback HTTP; it never needs file:// or
        // content:// access, so a hostile document cannot reach them either.
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.webViewClient = webViewClient
        webViewClient.onRenderProcessGone = { _ ->
            // The renderer died (OOM, crash): the WebView is unusable. Drop it
            // and recreate the Activity; the worklet keeps running and the new
            // page logs in again with the session cookie.
            releaseWebView()
            recreate()
        }
    }

    /** Injects the bootstrap nonce for the loopback origin only, confines the
     * WebView to that origin, then loads the page. The raw session token is
     * never exposed to page JS, only the single-use nonce. */
    private fun load(handoff: BareHandoff) {
        if (webViewReleased) return
        if (host.bootstrapDelivered) {
            // The nonce is spent and the session cookie is set: a WebView
            // created later (recreation, a second Activity) gets no nonce and
            // the page connects on the cookie.
        } else if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            bootstrapScript = WebViewCompat.addDocumentStartJavaScript(
                webView,
                handoff.bootstrapScript,
                // allowedOriginRules cannot wildcard the port; the handoff origin
                // carries the exact ephemeral port.
                setOf(handoff.origin),
            )
        } else {
            // Without document-start injection the nonce cannot reach the page
            // before its scripts run. Say so instead of polling forever.
            Log.e("BARE_KOTLIN", "This WebView does not support DOCUMENT_START_SCRIPT; update Android System WebView")
            showError(WEBVIEW_TOO_OLD)
            return
        }
        // Confine the WebView to the same origin before the first load.
        webViewClient.allowedOrigin = handoff.origin
        webView.loadUrl(handoff.indexUrl)
    }

    private fun showError(message: String) {
        if (webViewReleased) return
        webView.loadDataWithBaseURL(null, "<p style=\"font-family:sans-serif;padding:16px\">$message</p>", "text/html", "utf-8", null)
    }

    override fun onDestroy() {
        host.detach(this, isFinishing && !isChangingConfigurations)
        releaseWebView()
        super.onDestroy()
    }

    private fun releaseWebView() {
        if (webViewReleased) return
        webViewReleased = true
        bootstrapScript = null
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
    }

    // --- ReferenceHost.Ui ---------------------------------------------------

    override fun launchPermission(permission: String) = permissionLauncher.launch(permission)

    override fun launchCameraPermission() = cameraPermissionLauncher.launch(Manifest.permission.CAMERA)

    override fun launchPick(video: Boolean) {
        val selector =
            if (video) {
                ActivityResultContracts.PickVisualMedia.VideoOnly
            } else {
                ActivityResultContracts.PickVisualMedia.ImageOnly
            }
        pickLauncher.launch(PickVisualMediaRequest(selector))
    }

    override fun launchCapture(uri: Uri, video: Boolean) {
        if (video) videoCaptureLauncher.launch(uri) else imageCaptureLauncher.launch(uri)
    }

    private companion object {
        const val HANDOFF_FAILED = "The app backend has not started yet. Still waiting; restart the app if this stays."
        const val WEBVIEW_TOO_OLD = "This device's WebView is too old. Update Android System WebView and restart the app."
    }
}
