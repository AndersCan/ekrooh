import AVFoundation
import Foundation

/**
 * Registers the canonical host plugin handlers. Mirror of
 * `android/.../DefaultHostPlugins.kt`.
 *
 * Storage always reports `granted` on iOS — the app sandbox is always
 * accessible, there is no user permission to hold. Camera maps
 * `AVCaptureDevice.authorizationStatus(for: .video)`; `restricted` reports
 * `unsupported`.
 *
 * Plugin arguments are not validated by the worklet (docs/security.md §4), so
 * the permission id is allowlisted here: only `storage` and `camera` are
 * known. A missing, non-string, oversized or unknown id is `unsupported`,
 * never a grant (fail closed, like the Kotlin host).
 */
public func registerDefaultHostPlugins(_ registry: HostPluginRegistry) {
  registry.register(
    pluginId: "core.permissions",
    event: "permissions.status"
  ) { args, _, respond in
    let permission = permissionId(from: args)
    respond(.ok(["permission": permission, "status": permissionStatus(permission)]))
  }

  // `requestAccess` shows a system prompt the user may leave open, so this
  // handler gets the user-mediated deadline, not the 30 s default.
  registry.register(
    pluginId: "core.permissions",
    event: "permissions.request",
    timeout: HostPluginRegistry.userMediatedInvokeTimeout
  ) { args, _, respond in
    let permission = permissionId(from: args)
    switch permission {
    case "storage":
      respond(.ok(["permission": permission, "status": "granted"]))
    case "camera":
      AVCaptureDevice.requestAccess(for: .video) { granted in
        respond(
          .ok([
            "permission": permission,
            "status": granted ? "granted" : "denied",
          ])
        )
      }
    default:
      respond(.ok(["permission": permission, "status": "unsupported"]))
    }
  }
}

/// The `permission` argument when it is a string of at most
/// `HostIpcRouter.maxFieldBytes` UTF-8 bytes, else `""` (which is unknown, so
/// `unsupported`). Never defaults to a permission that would be granted.
func permissionId(from args: [String: Any]?) -> String {
  guard let id = args?["permission"] as? String,
    id.utf8.count <= HostIpcRouter.maxFieldBytes
  else { return "" }
  return id
}

func permissionStatus(_ permission: String) -> String {
  switch permission {
  case "storage":
    // iOS has no storage permission; the app sandbox is always accessible.
    return "granted"
  case "camera":
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .notDetermined: return "notDetermined"
    case .restricted: return "unsupported"
    @unknown default: return "unsupported"
    }
  default:
    // Unknown permissions are never auto-granted — report unsupported rather
    // than claiming a grant the host does not actually hold.
    return "unsupported"
  }
}
