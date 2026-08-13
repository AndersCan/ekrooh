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
 */
public func registerDefaultHostPlugins(_ registry: HostPluginRegistry) {
  let statusFor = { (permission: String) -> String in
    switch permission {
    case "camera":
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized: return "granted"
      case .denied: return "denied"
      case .notDetermined: return "notDetermined"
      case .restricted: return "unsupported"
      @unknown default: return "unsupported"
      }
    default:
      return "granted"
    }
  }

  registry.register(
    pluginId: "core.permissions",
    event: "permissions.status"
  ) { args, _, respond in
    let permission = args?["permission"] as? String ?? "storage"
    respond(.ok(["permission": permission, "status": statusFor(permission)]))
  }

  registry.register(
    pluginId: "core.permissions",
    event: "permissions.request"
  ) { args, _, respond in
    let permission = args?["permission"] as? String ?? "storage"
    switch permission {
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
      respond(.ok(["permission": permission, "status": "granted"]))
    }
  }
}
