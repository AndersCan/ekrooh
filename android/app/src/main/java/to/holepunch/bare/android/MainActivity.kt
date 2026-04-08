package to.holepunch.bare.android

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet

class MainActivity : AppCompatActivity() {
    private lateinit var worklet: Worklet
    private lateinit var ipc: IPC
    private lateinit var webView: WebView
    private val hostPlugins = HostPluginRegistry()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        worklet = Worklet(Worklet.Options().memoryLimit(128 * 1024 * 1024))

        val backendMessenger = WebViewBackendMessenger(this) {
            if (::webView.isInitialized) webView else null
        }

        try {
            val bundleStream = assets.open("main.core.bundle")
            worklet.start("/main.core.bundle", bundleStream, null)
            ipc = IPC(worklet)
            registerDefaultHostPlugins(hostPlugins)
            HostIpcCoordinator(ipc, hostPlugins, backendMessenger::push).start()
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

        webView.webViewClient = BareWebViewClient(this, assetLoader)

        webView.addJavascriptInterface(
            BareBridge { if (::ipc.isInitialized) ipc else null },
            "NativeBridge",
        )
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
}
