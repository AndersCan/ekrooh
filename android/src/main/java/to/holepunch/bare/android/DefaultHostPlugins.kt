package to.holepunch.bare.android

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Canonical `core.permissions` permission ids the worklet can request, mapped
 * to the real Android runtime permission they gate. A null value means the
 * feature needs **no** runtime grant on the reference host: `storage` is the
 * system photo/video picker (scoped storage, no grant on API 29+), so
 * `media.pick` and `media.capture` never require a runtime permission.
 */
private val permissionIds: Map<String, String?> = mapOf(
    "camera" to Manifest.permission.CAMERA,
    "storage" to null,
)

/**
 * Canonical status for a permission id. Unknown ids are `unsupported` (never
 * silently granted); a known id backed by a real runtime permission reports its
 * actual grant state via [ContextCompat.checkSelfPermission] when a [Context]
 * is available (fail-closed to `denied` without one). A known id with no
 * runtime permission (scoped storage) reports `granted` because the host needs
 * no grant for it. Hosts that render a system permission dialog delegate status
 * resolution here.
 */
fun resolvePermissionStatus(id: String, context: Context?): String {
    if (!permissionIds.containsKey(id)) return "unsupported"
    val androidPermission = permissionIds[id]
    if (androidPermission == null) return "granted"
    val granted =
        context != null &&
            ContextCompat.checkSelfPermission(context, androidPermission) ==
            PackageManager.PERMISSION_GRANTED
    return if (granted) "granted" else "denied"
}

/**
 * The Android runtime permission (e.g. [Manifest.permission.CAMERA]) whose
 * system dialog the host would show for a canonical id, or null when the id is
 * unknown or needs no runtime grant. Handlers render a dialog only when this is
 * non-null; otherwise they report [resolvePermissionStatus].
 */
fun androidPermissionFor(id: String): String? =
    if (permissionIds.containsKey(id)) permissionIds[id] else null

fun registerDefaultHostPlugins(registry: HostPluginRegistry, context: Context? = null) {
    fun respond(permission: String, status: String): HostPluginRegistry.HostInvokeOutcome =
        HostPluginRegistry.HostInvokeOutcome.Ok(
            JSONObject().put("permission", permission).put("status", status),
        )

    // Both events report the real grant state; a host that wants a system
    // permission dialog overrides `permissions.request` with an Activity Result
    // launcher (see the reference MainActivity). Without one, request reflects
    // status only and never fabricates a grant.
    registry.register("core.permissions", "permissions.request") { args, _, callback ->
        // A missing permission id must fail closed (unsupported), never
        // silently resolve to a granted capability.
        val id = args?.optString("permission") ?: ""
        callback(respond(id, resolvePermissionStatus(id, context)))
    }
    registry.register("core.permissions", "permissions.status") { args, _, callback ->
        val id = args?.optString("permission") ?: ""
        callback(respond(id, resolvePermissionStatus(id, context)))
    }
}
