package to.holepunch.bare.android

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet
import java.io.File

/**
 * Injected as `window.BareShell`: a presence marker so the web layer can detect
 * the bootstrap bridge. The actual data path is a WebMessagePort.
 */
class BareShellMarker {
    @JavascriptInterface
    fun ready(): Boolean = true
}

class MainActivity : AppCompatActivity() {
    private lateinit var worklet: Worklet
    private lateinit var ipc: IPC
    private lateinit var webView: WebView
    private val hostPlugins = HostPluginRegistry()
    private lateinit var portMessenger: BarePortMessenger

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        worklet = Worklet(Worklet.Options().memoryLimit(128 * 1024 * 1024))
        portMessenger = BarePortMessenger { if (::ipc.isInitialized) ipc else null }

        try {
            val bundleStream = assets.open("main.core.bundle")
            worklet.start("/main.core.bundle", bundleStream, null)
            ipc = IPC(worklet)
            registerDefaultHostPlugins(hostPlugins)
            registerMediaHostPlugins(hostPlugins)
            HostIpcCoordinator(ipc, hostPlugins, portMessenger::push).start()
        } catch (e: Exception) {
            Log.e("BARE_KOTLIN", "Failed to start worklet", e)
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = findViewById(R.id.webview)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = true
        // The media plugin serves bytes from the worklet's loopback HTTP
        // server; allow those cleartext subresource loads (usesCleartextTraffic
        // covers ATS-equivalent, this covers https-page mixed content).
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        webView.webViewClient = BareWebViewClient(this, assetLoader) {
            portMessenger.attachTo(webView)
        }
        webView.addJavascriptInterface(BareShellMarker(), "BareShell")
        webView.loadUrl("https://${BareWebViewClient.ASSETS_HOST}${BareWebViewClient.ASSETS_PATH_PREFIX}index.html")

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (!::webView.isInitialized) {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        return
                    }
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

    override fun onDestroy() {
        super.onDestroy()
        if (::ipc.isInitialized) ipc.close()
        if (::worklet.isInitialized) worklet.terminate()
    }

    /**
     * Reference host handlers for `vendor.media`: the worklet serves the
     * returned path over its loopback HTTP server, so no bytes cross the
     * bridge. Stubs return a bundled sample; wire up a real picker/camera.
     */
    private fun registerMediaHostPlugins(registry: HostPluginRegistry) {
        for (event in listOf("media.pick", "media.capture")) {
            registry.register("vendor.media", event) { _, _ ->
                HostPluginRegistry.HostInvokeOutcome.Ok(
                    JSONObject().put("path", sampleMediaPath()),
                )
            }
        }
    }

    private var sampleMediaPath: String? = null

    private fun sampleMediaPath(): String {
        sampleMediaPath?.let { return it }
        val dest = File(cacheDir, "sample.png")
        if (!dest.exists()) {
            resources.openRawResource(R.raw.sample).use { input ->
                dest.outputStream().use { output -> input.copyTo(output) }
            }
        }
        sampleMediaPath = dest.absolutePath
        return dest.absolutePath
    }
}
