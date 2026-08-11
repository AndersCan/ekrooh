package to.holepunch.bare.android

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
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet
import java.io.File

class MainActivity : AppCompatActivity() {
    private lateinit var worklet: Worklet
    private lateinit var ipc: IPC
    private lateinit var webView: WebView
    private val hostPlugins = HostPluginRegistry()
    private lateinit var storageDir: File
    private lateinit var webappDir: File
    private val mainHandler = Handler(Looper.getMainLooper())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // bare-fs cannot read APK assets by path, so copy the built web app out
        // of assets/ into the cache dir for the worklet to serve over loopback.
        // Always re-copy: cacheDir survives `adb install -r`, so an existing
        // copy would otherwise go stale across rebuilds.
        storageDir = File(cacheDir, "bare").apply { mkdirs() }
        webappDir = File(cacheDir, "webapp")
        copyWebAssets(webappDir)

        // A previous run may have left a handoff file pointing at a dead
        // ephemeral port; remove it so polling never loads a stale origin.
        File(storageDir, "handoff.json").delete()

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
                    arrayOf(webappDir.absolutePath, storageDir.absolutePath),
                )
            }
            ipc = IPC(worklet)
            registerDefaultHostPlugins(hostPlugins)
            registerMediaHostPlugins(hostPlugins)
            HostIpcCoordinator(ipc, hostPlugins).start()
        } catch (e: Exception) {
            Log.e("BARE_KOTLIN", "Failed to start worklet", e)
        }

        webView = findViewById(R.id.webview)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        webView.webViewClient = BareWebViewClient()

        waitForHandoffAndLoad()

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

    /** Polls the worklet's `handoff.json` (written once the loopback server is
     * up), injects the session token + shell marker, then loads the page. */
    private fun waitForHandoffAndLoad() {
        val handoff = File(storageDir, "handoff.json")
        val deadline = System.currentTimeMillis() + 15_000
        fun poll() {
            val text = if (handoff.exists()) handoff.readText() else null
            if (text != null) {
                try {
                    val json = JSONObject(text)
                    val origin = json.getString("origin")
                    val token = json.getString("token")
                    WebViewCompat.addDocumentStartJavaScript(
                        webView,
                        "window.__lessBareToken='$token';window.BareShell=true;",
                        setOf("http://127.0.0.1:*"),
                    )
                    webView.loadUrl("$origin/index.html")
                    return
                } catch (e: Exception) {
                    Log.e("BARE_KOTLIN", "Handoff malformed", e)
                }
            }
            if (System.currentTimeMillis() < deadline) {
                mainHandler.postDelayed({ poll() }, 100)
            } else {
                Log.e("BARE_KOTLIN", "Timed out waiting for worklet handoff file")
            }
        }
        poll()
    }

    /** Copies `index.html` and the `assets/` directory out of the APK so the
     * worklet can serve them from the filesystem. */
    private fun copyWebAssets(destDir: File) {
        destDir.deleteRecursively()
        destDir.mkdirs()
        try {
            assets.open("index.html").use { input ->
                File(destDir, "index.html").outputStream().use { input.copyTo(it) }
            }
            copyAssetTree("assets", destDir)
        } catch (e: Exception) {
            Log.e("BARE_KOTLIN", "Failed to copy web assets", e)
        }
    }

    private fun copyAssetTree(prefix: String, destDir: File) {
        val names = assets.list(prefix) ?: return
        for (name in names) {
            val assetPath = if (prefix.isEmpty()) name else "$prefix/$name"
            val dest = File(destDir, assetPath)
            // AssetManager.list() returns null for files and an array for
            // directories (empty for an empty dir).
            if (assets.list(assetPath) != null) {
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
