package to.holepunch.bare.android

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONObject
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The reference app's backend for the whole process: the Bare worklet, its
 * IPC coordinator, the host plugins and the handoff. Activities attach to it
 * and are only the UI the host plugins launch system screens from.
 *
 * Lifetime: started when the first Activity attaches, stopped when the last
 * one finishes (back out of the app). Recreating an Activity (configuration
 * change, the system reclaiming it in the background) or a second instance
 * never restarts the worklet, never re-copies the web root under it, and
 * keeps in-flight picker/camera/permission calls alive: their results arrive
 * at whichever Activity is attached and route back here.
 *
 * Threading: [attach]/[detach]/[whenReady] run on the main thread. Host
 * handlers run on the IPC thread and post UI work to the main thread.
 */
class ReferenceHost(private val app: Application) {
    /** What a host plugin needs from the attached Activity. Every launch may
     * throw (e.g. no camera app); the host then fails the call. */
    interface Ui {
        fun launchPermission(permission: String)

        fun launchCameraPermission()

        fun launchPick(video: Boolean)

        fun launchCapture(uri: Uri, video: Boolean)
    }

    private class PendingPermission(val id: String, val respond: (HostPluginRegistry.HostInvokeOutcome) -> Unit) {
        val startedAt = SystemClock.elapsedRealtime()
    }

    private class PendingMedia(val respond: (HostPluginRegistry.HostInvokeOutcome) -> Unit, val video: Boolean, val captureFile: File?) {
        val startedAt = SystemClock.elapsedRealtime()
    }

    companion object {
        private const val TAG = "BARE_KOTLIN"
        private const val HANDOFF_TIMEOUT_MS = 15_000L
        private const val HANDOFF_POLL_MS = 100L

        /** After [HANDOFF_TIMEOUT_MS] the error is shown, but polling goes on
         * at this slower rate: a late handoff still loads the page and is
         * still consumed (deleted), so its nonce never lingers on disk. */
        private const val HANDOFF_SLOW_POLL_MS = 1_000L

        /** Largest picked file copied into the cache for the worklet. */
        const val MAX_PICK_BYTES: Long = 1L shl 30

        /** Captures and picks older than this are deleted on startup. */
        private const val CAPTURE_MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000

        /** Media types kept with their own extension, so the worklet serves
         * them with the right Content-Type. Anything else is stored as `.bin`
         * (served as `application/octet-stream`). SVG is deliberately absent. */
        private val EXTENSION_BY_MIME = mapOf(
            "image/jpeg" to ".jpg",
            "image/png" to ".png",
            "image/gif" to ".gif",
            "image/webp" to ".webp",
            "image/heic" to ".heic",
            "image/heif" to ".heif",
            "video/mp4" to ".mp4",
            "video/quicktime" to ".mov",
            "video/x-m4v" to ".m4v",
        )

        /** File extension for a picked item's MIME type. */
        fun extensionFor(mime: String?): String =
            EXTENSION_BY_MIME[mime?.lowercase()?.substringBefore(';')?.trim()] ?: ".bin"
    }

    private val main = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    val registry = HostPluginRegistry()

    /** Durable worklet storage (p2p corestore, keys, `handoff.json`). In
     * `noBackupFilesDir`: survives "Clear cache" and storage pressure, and is
     * never backed up or transferred. */
    val storageDir: File get() = activeStorage ?: File(app.noBackupFilesDir, "bare")

    /** The storage chosen at [start] (the legacy directory only while a
     * migration keeps failing; see [StorageMigration]). */
    private var activeStorage: File? = null
    private val legacyStorageDir: File get() = File(app.cacheDir, "bare")
    private val webappDir: File get() = File(app.cacheDir, "webapp")
    private val bareCacheDir: File get() = File(app.cacheDir, "bare-cache")

    /** Camera/picker outputs: the only directory the FileProvider exposes. */
    val capturesDir: File get() = File(app.cacheDir, "captures")

    private var worklet: Worklet? = null
    private var ipc: IPC? = null
    private var coordinator: HostIpcCoordinator? = null
    private var handoff: BareHandoff? = null
    private var handoffFailed = false

    /** True once a WebView has run the bootstrap script and finished loading:
     * the nonce is spent and the session cookie is set (process-wide), so a
     * WebView created later (recreation, a second Activity) gets no nonce. */
    var bootstrapDelivered = false
        private set
    private val readyListeners = LinkedHashMap<Any, (BareHandoff?) -> Unit>()
    private val activities = LinkedHashSet<Ui>()
    private var pollRunnable: Runnable? = null

    private val slotLock = Any()
    private var permissionSlot: PendingPermission? = null
    private var mediaSlot: PendingMedia? = null

    init {
        registerDefaultHostPlugins(registry, app)
        registerPermissionHostPlugins()
        registerMediaHostPlugins()
    }

    /** The Activity host plugins launch from: the most recently attached. */
    private val foreground: Ui? get() = activities.lastOrNull()

    /** Attaches [ui] and starts the worklet if it is not running. Main thread. */
    fun attach(ui: Ui) {
        activities.remove(ui)
        activities.add(ui)
        if (worklet == null) start()
    }

    /** Detaches [ui]. When it was the last Activity and it is finishing for
     * good (not a configuration change), the worklet stops. Main thread. */
    fun detach(ui: Ui, finishing: Boolean) {
        activities.remove(ui)
        readyListeners.remove(ui)
        if (activities.isEmpty() && finishing) stop()
    }

    /** Calls [listener] with the handoff once the loopback server is up (at
     * once if it already is). While it is late it is also called with null
     * (show an error), and called again with the handoff if it still arrives.
     * [owner] keys the registration so [detach] drops it. Main thread. */
    fun whenReady(owner: Any, listener: (BareHandoff?) -> Unit) {
        val ready = handoff
        if (ready != null) {
            listener(ready)
            return
        }
        readyListeners[owner] = listener
        if (handoffFailed) listener(null)
    }

    /** Records that a WebView loaded the page with the bootstrap script. */
    fun markBootstrapDelivered() {
        bootstrapDelivered = true
    }

    private fun start() {
        // Fail fast on unsupported 32-bit runtimes: the worklet's native
        // thread bootstrap is unreliable there (ekrooh#46), so surface a clear
        // error instead of a native SIGSEGV.
        BareHostAbi.requireSupportedAbi()

        activeStorage = StorageMigration.resolve(
            legacyStorageDir,
            File(app.noBackupFilesDir, "bare"),
        ) { message -> Log.e(TAG, message) }
        storageDir.mkdirs()
        bareCacheDir.mkdirs()
        capturesDir.mkdirs()
        pruneCaptures()
        // bare-fs cannot read APK assets by path, so copy the built web app out
        // of assets/ for the worklet to serve over loopback. Only here, before
        // the worklet starts: a running worklet's web root is never touched.
        // Always re-copy: cacheDir survives `adb install -r`.
        copyWebAssets(webappDir)

        // A previous run may have left a handoff file pointing at a dead
        // ephemeral port; remove it so polling never loads a stale origin.
        File(storageDir, "handoff.json").delete()
        handoff = null
        handoffFailed = false
        bootstrapDelivered = false

        val w = Worklet(
            Worklet.Options()
                .memoryLimit(128 * 1024 * 1024)
                .assets(File(bareCacheDir, "asset-cache").absolutePath),
        )
        worklet = w
        try {
            app.assets.open("main.core.bundle").use { bundleStream ->
                w.start(
                    "/main.core.bundle",
                    bundleStream,
                    // On-device argv contract: [webAssets, storage, cache] (see
                    // `resolveWorkletConfig()`). All three must be directories.
                    arrayOf(
                        webappDir.absolutePath,
                        storageDir.absolutePath,
                        bareCacheDir.absolutePath,
                    ),
                )
            }
            val channel = IPC(w)
            ipc = channel
            coordinator = HostIpcCoordinator(channel, registry).also { it.start() }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start worklet: ${e.javaClass.simpleName}")
            reportHandoffLate()
            return
        }
        pollHandoff()
    }

    private fun stop() {
        pollRunnable?.let { main.removeCallbacks(it) }
        pollRunnable = null
        coordinator?.stop()
        coordinator = null
        ipc?.close()
        ipc = null
        worklet?.terminate()
        worklet = null
        handoff = null
        handoffFailed = false
        bootstrapDelivered = false
        activeStorage = null
        synchronized(slotLock) {
            permissionSlot = null
            mediaSlot = null
        }
    }

    /** Polls for `handoff.json`. The file is deleted as soon as it parses; its
     * contents are never logged (it carries the bootstrap nonce). */
    private fun pollHandoff() {
        val file = File(storageDir, "handoff.json")
        val deadline = SystemClock.elapsedRealtime() + HANDOFF_TIMEOUT_MS
        val poll = object : Runnable {
            override fun run() {
                val parsed = BareHandoff.consume(file)
                when {
                    parsed != null -> finishHandoff(parsed)
                    SystemClock.elapsedRealtime() < deadline -> main.postDelayed(this, HANDOFF_POLL_MS)
                    else -> {
                        if (!handoffFailed) {
                            Log.e(TAG, "Timed out waiting for a valid worklet handoff file; still polling")
                            reportHandoffLate()
                        }
                        main.postDelayed(this, HANDOFF_SLOW_POLL_MS)
                    }
                }
            }
        }
        pollRunnable = poll
        poll.run()
    }

    private fun finishHandoff(result: BareHandoff) {
        pollRunnable = null
        handoff = result
        handoffFailed = false
        val listeners = readyListeners.values.toList()
        readyListeners.clear()
        for (listener in listeners) listener(result)
    }

    /** Tells listeners the handoff is late (they show an error) but keeps
     * them registered for a handoff that still arrives. */
    private fun reportHandoffLate() {
        handoffFailed = true
        for (listener in readyListeners.values.toList()) listener(null)
    }

    private fun pruneCaptures() {
        val cutoff = System.currentTimeMillis() - CAPTURE_MAX_AGE_MS
        capturesDir.listFiles()?.forEach { f ->
            if (f.isFile && f.lastModified() < cutoff) f.delete()
        }
    }

    /** Copies `index.html` and the `assets/` directory out of the APK so the
     * worklet can serve them from the filesystem. */
    private fun copyWebAssets(destDir: File) {
        destDir.deleteRecursively()
        destDir.mkdirs()
        try {
            app.assets.open("index.html").use { input ->
                File(destDir, "index.html").outputStream().use { input.copyTo(it) }
            }
            copyAssetTree("assets", destDir)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to copy web assets", e)
        }
    }

    private fun copyAssetTree(prefix: String, destDir: File) {
        val names = app.assets.list(prefix) ?: return
        for (name in names) {
            val assetPath = if (prefix.isEmpty()) name else "$prefix/$name"
            val dest = File(destDir, assetPath)
            val children = app.assets.list(assetPath)
            if (children != null && children.isNotEmpty()) {
                dest.mkdirs()
                copyAssetTree(assetPath, destDir)
            } else {
                try {
                    app.assets.open(assetPath).use { input ->
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

    // --- core.permissions --------------------------------------------------

    /**
     * `permissions.request` shows the system runtime-permission dialog for ids
     * backed by a real Android runtime permission (camera) and returns the
     * real outcome. Ids needing no runtime grant (storage → system picker) or
     * unknown ids are reported via [resolvePermissionStatus] without a dialog,
     * never a fabricated grant.
     */
    private fun registerPermissionHostPlugins() {
        registry.register(
            "core.permissions",
            "permissions.request",
            HostPluginRegistry.INTERACTIVE_TIMEOUT_MS,
        ) { args, _, respond ->
            // Missing id fails closed (unsupported) rather than resolving to a
            // granted capability.
            val id = args?.optString("permission") ?: ""
            val androidPermission = androidPermissionFor(id)
            if (androidPermission == null || isGranted(androidPermission)) {
                respond(permissionOutcome(id, resolvePermissionStatus(id, app)))
                return@register
            }
            synchronized(slotLock) {
                if (permissionSlot?.let { !isStale(it.startedAt) } == true) {
                    respond(fail("Concurrent permission invocation not supported"))
                    return@register
                }
                permissionSlot = PendingPermission(id, respond)
            }
            main.post {
                val ui = foreground
                try {
                    if (ui == null) throw IllegalStateException("no foreground activity")
                    ui.launchPermission(androidPermission)
                } catch (e: Exception) {
                    takePermission()?.respond?.invoke(fail("Permission dialog unavailable"))
                }
            }
        }
    }

    /** Result of the dialog started by `permissions.request`. Main thread. */
    fun onPermissionResult(granted: Boolean) {
        val slot = takePermission() ?: return
        slot.respond(permissionOutcome(slot.id, if (granted) "granted" else "denied"))
    }

    private fun takePermission(): PendingPermission? =
        synchronized(slotLock) { permissionSlot.also { permissionSlot = null } }

    private fun permissionOutcome(id: String, status: String) =
        HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("permission", id).put("status", status))

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(app, permission) == PackageManager.PERMISSION_GRANTED

    // --- vendor.media ------------------------------------------------------

    /**
     * `media.pick` opens the system photo/video picker; `media.capture` opens
     * the camera (asking for the camera permission first when needed). Both
     * put the result in [capturesDir] and return its filesystem path, which
     * the worklet serves over loopback, so no bytes cross the wire.
     */
    private fun registerMediaHostPlugins() {
        registry.register("vendor.media", "media.pick", HostPluginRegistry.INTERACTIVE_TIMEOUT_MS) { args, _, respond ->
            val video = args?.optString("kind") == "video"
            if (!claimMedia(PendingMedia(respond, video, null))) {
                respond(fail("Concurrent media invocation not supported"))
                return@register
            }
            main.post {
                val ui = foreground
                try {
                    if (ui == null) throw IllegalStateException("no foreground activity")
                    ui.launchPick(video)
                } catch (e: Exception) {
                    takeMedia()?.respond?.invoke(fail("Media picker unavailable"))
                }
            }
        }
        registry.register("vendor.media", "media.capture", HostPluginRegistry.INTERACTIVE_TIMEOUT_MS) { args, _, respond ->
            val video = args?.optString("kind") == "video"
            val file = File(capturesDir, "${UUID.randomUUID()}${if (video) ".mp4" else ".jpg"}")
            if (!claimMedia(PendingMedia(respond, video, file))) {
                respond(fail("Concurrent media invocation not supported"))
                return@register
            }
            main.post {
                if (isGranted(Manifest.permission.CAMERA)) {
                    launchCapture()
                } else {
                    val ui = foreground
                    try {
                        if (ui == null) throw IllegalStateException("no foreground activity")
                        ui.launchCameraPermission()
                    } catch (e: Exception) {
                        takeMedia()?.respond?.invoke(fail("Camera permission dialog unavailable"))
                    }
                }
            }
        }
    }

    /** Result of the camera-permission dialog started by `media.capture`. */
    fun onCameraPermissionResult(granted: Boolean) {
        if (granted) {
            launchCapture()
        } else {
            takeMedia()?.respond?.invoke(fail("Camera permission denied"))
        }
    }

    /** Launches the camera for the pending capture. Main thread. */
    private fun launchCapture() {
        val slot = synchronized(slotLock) { mediaSlot } ?: return
        val file = slot.captureFile ?: return
        val ui = foreground
        try {
            if (ui == null) throw IllegalStateException("no foreground activity")
            val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file)
            ui.launchCapture(uri, slot.video)
        } catch (e: Exception) {
            // No camera app, camera disabled by policy, or no Activity.
            takeMedia()?.respond?.invoke(fail("Camera unavailable"))
        }
    }

    /** Result of the camera started by `media.capture`. Main thread. */
    fun onCaptureResult(success: Boolean) {
        val slot = takeMedia() ?: return
        val file = slot.captureFile
        if (success && file != null && file.isFile && file.length() > 0L) {
            slot.respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("path", file.absolutePath)))
        } else {
            file?.delete()
            slot.respond(fail("Capture cancelled or failed"))
        }
    }

    /** Result of the picker started by `media.pick`. Main thread; the copy
     * runs on a background thread. */
    fun onPickResult(uri: Uri?) {
        val slot = takeMedia() ?: return
        if (uri == null) {
            slot.respond(fail("Media pick cancelled"))
            return
        }
        io.execute {
            val path = copyUriToCaptures(uri)
            slot.respond(
                if (path == null) {
                    fail("Failed to copy picked media")
                } else {
                    HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("path", path))
                },
            )
        }
    }

    private fun claimMedia(pending: PendingMedia): Boolean = synchronized(slotLock) {
        if (mediaSlot?.let { !isStale(it.startedAt) } == true) return false
        mediaSlot = pending
        true
    }

    private fun takeMedia(): PendingMedia? =
        synchronized(slotLock) { mediaSlot.also { mediaSlot = null } }

    /** A slot older than the interactive deadline was already answered with
     * TIMEOUT by the coordinator; a new call may take it over. */
    private fun isStale(startedAt: Long): Boolean =
        SystemClock.elapsedRealtime() - startedAt > HostPluginRegistry.INTERACTIVE_TIMEOUT_MS

    /** Copies a picker content:// URI into [capturesDir], up to
     * [MAX_PICK_BYTES]. Background thread. */
    private fun copyUriToCaptures(uri: Uri): String? {
        val dest = File(capturesDir, "media-${UUID.randomUUID()}${extensionFor(app.contentResolver.getType(uri))}")
        return try {
            val input = app.contentResolver.openInputStream(uri) ?: return null
            input.use { source ->
                dest.outputStream().use { sink ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val n = source.read(buffer)
                        if (n < 0) break
                        total += n
                        if (total > MAX_PICK_BYTES) throw IOException("picked file exceeds the size limit")
                        sink.write(buffer, 0, n)
                    }
                }
            }
            dest.absolutePath
        } catch (e: Exception) {
            Log.e(TAG, "Failed to copy picked media: ${e.javaClass.simpleName}")
            dest.delete()
            null
        }
    }

    private fun fail(message: String) =
        HostPluginRegistry.HostInvokeOutcome.Fail(ErrorCodes.HOST_ERROR, message)
}
