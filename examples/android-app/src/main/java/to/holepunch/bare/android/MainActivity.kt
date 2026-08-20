package to.holepunch.bare.android

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
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
    private lateinit var bareCacheDir: File
    private val mainHandler = Handler(Looper.getMainLooper())

    // vendor.media: native picker/camera launchers. The host handlers run on the
    // IPC thread and launch on the main thread; the result routes back through
    // [pendingMedia] to the worklet as the HOST_INVOKE_RESPONSE.
    private lateinit var pickLauncher: ActivityResultLauncher<PickVisualMediaRequest>
    private lateinit var imageCaptureLauncher: ActivityResultLauncher<Uri>
    private lateinit var videoCaptureLauncher: ActivityResultLauncher<Uri>
    @Volatile
    private var pendingMedia: ((HostPluginRegistry.HostInvokeOutcome) -> Unit)? = null
    @Volatile
    private var pendingCaptureFile: File? = null

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
        bareCacheDir = File(cacheDir, "bare-cache").apply { mkdirs() }
        copyWebAssets(webappDir)

        // A previous run may have left a handoff file pointing at a dead
        // ephemeral port; remove it so polling never loads a stale origin.
        File(storageDir, "handoff.json").delete()

        // Fail fast on unsupported 32-bit-only runtimes: the worklet's native
        // thread bootstrap is unreliable there (ekrooh#46), so surface a clear
        // error instead of a native SIGSEGV.
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
                    // On-device argv contract: [webAssets, storage, cache] (see
                    // `resolveWorkletConfig()`). All three must be directories;
                    // a missing/absent cache falls back to storage with a
                    // warning, so pass a real cache dir to keep boots quiet.
                    arrayOf(
                        webappDir.absolutePath,
                        storageDir.absolutePath,
                        bareCacheDir.absolutePath,
                    ),
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
     * up), injects the one-time bootstrap nonce + shell marker, then loads the
     * page. The raw session token is never exposed to page JS — only the
     * single-use nonce the page exchanges once via `POST /login`. */
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
                        "window.__ekrooh={bootstrap:'$bootstrap'};window.BareShell=true;",
                        // allowedOriginRules cannot wildcard the port; the
                        // handoff already knows the exact ephemeral port.
                        setOf("http://127.0.0.1:$port"),
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
            val children = assets.list(assetPath)
            if (children != null && children.isNotEmpty()) {
                // Directory with children — recurse.
                dest.mkdirs()
                copyAssetTree(assetPath, destDir)
            } else {
                try {
                    assets.open(assetPath).use { input ->
                        dest.parentFile?.mkdirs()
                        dest.outputStream().use { input.copyTo(it) }
                    }
                } catch (e: java.io.FileNotFoundException) {
                    // Empty directory (list() returns [] for both files and
                    // empty dirs on some Android versions).
                    dest.mkdirs()
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
     * returned path over its loopback HTTP server, so no bytes cross the wire.
     * `media.pick` opens the system photo/video picker; `media.capture` opens
     * the camera. Both copy the result into the app cache and return a
     * filesystem path the worklet can serve.
     */
    private fun registerMediaHostPlugins(registry: HostPluginRegistry) {
        // Registered in onCreate (before the activity is started), per the
        // Activity Result API contract.
        pickLauncher = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            val respond = pendingMedia ?: return@registerForActivityResult
            pendingMedia = null
            if (uri == null) {
                respond(
                    HostPluginRegistry.HostInvokeOutcome.Fail(
                        ErrorCodes.HOST_ERROR,
                        "Media pick cancelled",
                    ),
                )
                return@registerForActivityResult
            }
            val path = copyUriToCache(uri)
            if (path == null) {
                respond(
                    HostPluginRegistry.HostInvokeOutcome.Fail(
                        ErrorCodes.HOST_ERROR,
                        "Failed to copy picked media",
                    ),
                )
            } else {
                respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("path", path)))
            }
        }
        imageCaptureLauncher = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
            finishCapture(ok)
        }
        videoCaptureLauncher =
            registerForActivityResult(ActivityResultContracts.TakeVideo()) { thumbnail ->
                // TakeVideo's result is a thumbnail Bitmap (null when cancelled).
                finishCapture(thumbnail != null)
            }

        registry.register("vendor.media", "media.pick") { args, _, respond ->
            val kind = args?.optString("kind") ?: "image"
            pendingMedia = respond
            val selector =
                if (kind == "video") {
                    ActivityResultContracts.PickVisualMedia.VideoOnly
                } else {
                    ActivityResultContracts.PickVisualMedia.ImageOnly
                }
            mainHandler.post { pickLauncher.launch(PickVisualMediaRequest(selector)) }
        }
        registry.register("vendor.media", "media.capture") { args, _, respond ->
            val kind = args?.optString("kind") ?: "image"
            pendingMedia = respond
            val ext = if (kind == "video") ".mp4" else ".jpg"
            val file = File(cacheDir, "capture-${System.currentTimeMillis()}$ext")
            pendingCaptureFile = file
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            mainHandler.post {
                if (kind == "video") videoCaptureLauncher.launch(uri) else imageCaptureLauncher.launch(uri)
            }
        }
    }

    private fun finishCapture(success: Boolean) {
        val respond = pendingMedia ?: return
        pendingMedia = null
        val file = pendingCaptureFile ?: return
        pendingCaptureFile = null
        if (success && file.exists() && file.length() > 0L) {
            respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("path", file.absolutePath)))
        } else {
            respond(
                HostPluginRegistry.HostInvokeOutcome.Fail(
                    ErrorCodes.HOST_ERROR,
                    "Capture cancelled or failed",
                ),
            )
        }
    }

    /** Copies a picker content:// URI into the app cache so the worklet can
     * serve it from the filesystem. */
    private fun copyUriToCache(uri: Uri): String? {
        return try {
            val ext =
                contentResolver.getType(uri)?.let { mime ->
                    when {
                        mime.startsWith("image/") -> ".jpg"
                        mime.startsWith("video/") -> ".mp4"
                        else -> ".bin"
                    }
                } ?: ".bin"
            val dest = File(cacheDir, "media-${System.currentTimeMillis()}$ext")
            val copied =
                contentResolver.openInputStream(uri)?.use { input ->
                    dest.outputStream().use { output -> input.copyTo(output) }
                }
            if (copied == null) null else dest.absolutePath
        } catch (e: Exception) {
            Log.e("BARE_KOTLIN", "Failed to copy picked media", e)
            null
        }
    }
}
