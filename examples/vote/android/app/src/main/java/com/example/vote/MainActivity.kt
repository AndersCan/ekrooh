package com.example.vote

import android.annotation.SuppressLint
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import to.holepunch.bare.android.BareHostAbi
import to.holepunch.bare.android.BareWebViewClient
import to.holepunch.bare.android.HostIpcCoordinator
import to.holepunch.bare.android.HostPluginRegistry
import to.holepunch.bare.android.registerDefaultHostPlugins
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet
import java.io.File

class MainActivity : AppCompatActivity() {
    private lateinit var worklet: Worklet
    private lateinit var ipc: IPC
    private lateinit var webView: WebView
    private val webViewClient = BareWebViewClient()
    private val hostPlugins = HostPluginRegistry()
    private lateinit var storageDir: File
    private lateinit var webappDir: File
    private lateinit var bareCacheDir: File
    private val mainHandler = Handler(Looper.getMainLooper())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // bare-fs cannot read APK assets by path, so copy the built web app out
        // of assets/web into the cache dir for the worklet to serve over
        // loopback. Always re-copy: cacheDir survives `adb install -r`.
        storageDir = File(cacheDir, "bare").apply { mkdirs() }
        webappDir = File(cacheDir, "webapp")
        bareCacheDir = File(cacheDir, "bare-cache").apply { mkdirs() }
        webappDir.deleteRecursively()
        webappDir.mkdirs()
        copyAssetTree("web", webappDir)

        // A previous run may have left a handoff file pointing at a dead port.
        File(storageDir, "handoff.json").delete()

        BareHostAbi.requireSupportedAbi()

        worklet = Worklet(
            Worklet.Options()
                .memoryLimit(128 * 1024 * 1024)
                .assets(File(storageDir, "asset-cache").absolutePath),
        )

        try {
            assets.open("main.core.bundle").use { bundleStream ->
                worklet.start(
                    "/main.core.bundle",
                    bundleStream,
                    // argv contract: [webAssets, storage, cache]
                    arrayOf(
                        webappDir.absolutePath,
                        storageDir.absolutePath,
                        bareCacheDir.absolutePath,
                    ),
                )
            }
            ipc = IPC(worklet)
            registerDefaultHostPlugins(hostPlugins, this)
            HostIpcCoordinator(ipc, hostPlugins).start()
        } catch (e: Exception) {
            Log.e("BARE_KOTLIN", "Failed to start worklet", e)
        }

        webView = WebView(this)
        setContentView(webView)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.webViewClient = webViewClient

        waitForHandoffAndLoad()

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

    /** Polls the worklet's `handoff.json` (written once the loopback server is
     * up), injects the one-time bootstrap nonce, then loads the page. */
    private fun waitForHandoffAndLoad() {
        val handoff = File(storageDir, "handoff.json")
        val deadline = System.currentTimeMillis() + 15_000
        fun poll() {
            val text = if (handoff.exists()) handoff.readText() else null
            if (text != null) {
                try {
                    val json = JSONObject(text)
                    val origin = json.getString("origin")
                    val port = json.getInt("port")
                    val bootstrap = json.getString("bootstrap")
                    WebViewCompat.addDocumentStartJavaScript(
                        webView,
                        "window.__ekrooh={bootstrap:${JSONObject.quote(bootstrap)}};" +
                            "window.BareShell=true;",
                        setOf("http://127.0.0.1:$port"),
                    )
                    webViewClient.allowedOrigin = "http://127.0.0.1:$port"
                    webView.loadUrl("$origin/index.html")
                    // The nonce is single-use; delete the spent handoff.
                    handoff.delete()
                    return
                } catch (e: Exception) {
                    Log.e("BARE_KOTLIN", "Handoff malformed", e)
                }
            }
            if (System.currentTimeMillis() < deadline) {
                mainHandler.postDelayed({ poll() }, 100)
            } else {
                Log.e("BARE_KOTLIN", "Timed out waiting for worklet handoff file")
                webView.loadData(
                    "<p>The app backend did not start. See Logcat, tag BARE_KOTLIN.</p>",
                    "text/html",
                    "utf-8",
                )
            }
        }
        poll()
    }

    /** Copies the asset folder `prefix` (and everything below it) into
     * [destDir], keeping the path after `web/`. */
    private fun copyAssetTree(prefix: String, destDir: File) {
        val names = assets.list(prefix) ?: return
        for (name in names) {
            val assetPath = "$prefix/$name"
            val dest = File(destDir, assetPath.removePrefix("web/"))
            val children = assets.list(assetPath)
            if (children != null && children.isNotEmpty()) {
                dest.mkdirs()
                copyAssetTree(assetPath, destDir)
            } else {
                assets.open(assetPath).use { input ->
                    dest.parentFile?.mkdirs()
                    dest.outputStream().use { input.copyTo(it) }
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        mainHandler.removeCallbacksAndMessages(null)
        if (::ipc.isInitialized) ipc.close()
        if (::worklet.isInitialized) worklet.terminate()
    }
}
