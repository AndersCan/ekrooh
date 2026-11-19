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
import java.net.HttpURLConnection
import java.net.URL

private const val DEV_BACKEND_PORT = 8080

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
    private var coordinator: HostIpcCoordinator? = null
    private var devArgv: Array<String> = emptyArray()

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

        webView = WebView(this)
        setContentView(webView)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.webViewClient = webViewClient

        // Debug build only (DEV_SERVER_URL is empty in release): open the devtools
        // socket so the reload check can read the page, not left to the default.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEV_SERVER_URL.isNotEmpty())

        if (BuildConfig.DEV_SERVER_URL.isEmpty()) {
            startBundled()
        } else {
            // Debug build: use the page from "npm run dev" when it answers.
            Thread {
                val up = devServerAnswers(BuildConfig.DEV_SERVER_URL)
                mainHandler.post {
                    if (!isDestroyed) {
                        if (up) {
                            startDev()
                        } else {
                            Log.w("BARE_KOTLIN", "Dev server did not answer; loading the bundled page")
                            startBundled()
                        }
                    }
                }
            }.start()
        }

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

    /** The page from the last "npm run sync", served by the worklet. */
    private fun startBundled() {
        startWorklet(
            // argv contract: [webAssets, storage, cache]
            arrayOf(
                webappDir.absolutePath,
                storageDir.absolutePath,
                bareCacheDir.absolutePath,
            ),
        )
        waitForHandoffAndLoad()
    }

    /** Debug only: backend in dev mode (no login, like "npm run dev" on the
     * computer), page loaded from the dev server. */
    private fun startDev() {
        val url = BuildConfig.DEV_SERVER_URL
        devArgv = arrayOf(
            "webassets=${webappDir.absolutePath}",
            "storage=${storageDir.absolutePath}",
            "cache=${bareCacheDir.absolutePath}",
            "mode=dev",
            "origin=$url",
        )
        startWorklet(devArgv)
        webViewClient.allowedOrigin = url
        // ?backend= marks a debug app page: it does not reload itself on a save.
        webView.loadUrl("$url/?backend=$DEV_BACKEND_PORT")
        watchDevBundle(null)
    }

    private class DevBundle(val bytes: ByteArray, val etag: String)

    /** Debug only: the packed worklet from "npm run dev", or null when the
     * server has none or the caller already holds [etag]. */
    private fun fetchDevBundle(etag: String?): DevBundle? {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL("${BuildConfig.DEV_SERVER_URL}/__vote/worklet/android.bundle")
                .openConnection() as HttpURLConnection
            conn.connectTimeout = 1000
            conn.readTimeout = 5000
            if (etag != null) conn.setRequestProperty("If-None-Match", etag)
            val tag = conn.getHeaderField("ETag")
            if (conn.responseCode == 200 && tag != null) {
                DevBundle(conn.inputStream.use { it.readBytes() }, tag)
            } else {
                null
            }
        } catch (e: java.io.IOException) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun portOpen(): Boolean =
        try {
            java.net.Socket().use {
                it.connect(java.net.InetSocketAddress("127.0.0.1", DEV_BACKEND_PORT), 200)
            }
            true
        } catch (e: java.io.IOException) {
            false
        }

    /** Waits up to [seconds] for the backend port to open (or to close). */
    private fun waitPort(open: Boolean, seconds: Int): Boolean {
        val deadline = System.currentTimeMillis() + seconds * 1000L
        while (System.currentTimeMillis() < deadline) {
            if (portOpen() == open) return true
            Thread.sleep(100)
        }
        return portOpen() == open
    }

    private fun onMain(block: () -> Unit) {
        val done = java.util.concurrent.CountDownLatch(1)
        mainHandler.post {
            try {
                if (!isDestroyed) block()
            } finally {
                done.countDown()
            }
        }
        done.await(5, java.util.concurrent.TimeUnit.SECONDS)
    }

    /** Debug only: once a second, ask the dev server for a newer worklet and
     * restart the backend in this process when there is one. */
    private fun watchDevBundle(initial: String?) {
        Thread {
            var etag = initial
            while (!isDestroyed) {
                Thread.sleep(1000)
                val next = fetchDevBundle(etag) ?: continue
                etag = next.etag
                onMain {
                    coordinator?.stop()
                    if (::ipc.isInitialized) ipc.close()
                    worklet.terminate()
                }
                waitPort(false, 3)
                onMain { startWorklet(devArgv, next.bytes) }
                if (!waitPort(true, 10)) {
                    Log.e("BARE_KOTLIN", "The new worklet did not answer on $DEV_BACKEND_PORT")
                }
                onMain { webView.loadUrl("${BuildConfig.DEV_SERVER_URL}/?backend=$DEV_BACKEND_PORT") }
            }
        }.start()
    }

    private fun startWorklet(argv: Array<String>, bundle: ByteArray? = null) {
        worklet = Worklet(
            Worklet.Options()
                .memoryLimit(128 * 1024 * 1024)
                .assets(File(storageDir, "asset-cache").absolutePath),
        )
        try {
            val stream = bundle?.inputStream() ?: assets.open("main.core.bundle")
            stream.use { worklet.start("/main.core.bundle", it, argv) }
            ipc = IPC(worklet)
            registerDefaultHostPlugins(hostPlugins, this)
            coordinator = HostIpcCoordinator(ipc, hostPlugins).also { it.start() }
        } catch (e: Exception) {
            Log.e("BARE_KOTLIN", "Failed to start worklet", e)
        }
    }

    private fun devServerAnswers(base: String): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL("$base/@vite/client").openConnection() as HttpURLConnection
            conn.connectTimeout = 1000
            conn.readTimeout = 2000
            conn.responseCode == 200
        } catch (e: java.io.IOException) {
            false
        } finally {
            conn?.disconnect()
        }
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
        coordinator?.stop()
        if (::ipc.isInitialized) ipc.close()
        if (::worklet.isInitialized) worklet.terminate()
    }
}
