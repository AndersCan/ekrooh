import BareHost
import Foundation

/// Reference host handlers for `vendor.media` (the worklet's loopback HTTP
/// server serves the returned path to the web layer — no bytes on the wire).
/// Stubs: return a bundled sample image; wire up a real picker/camera (e.g.
/// PHPickerViewController / UIImagePickerController) for production.
enum MediaHostPlugins {
  static func register(_ registry: HostPluginRegistry) {
    for event in ["media.pick", "media.capture"] {
      registry.register(pluginId: "vendor.media", event: event) { _, _, respond in
        guard
          let path = Bundle.main.path(forResource: "sample", ofType: "png")
        else {
          respond(
            .fail(
              code: ErrorCodes.hostError,
              message: "Sample media missing from app bundle"
            )
          )
          return
        }
        respond(.ok(["path": path]))
      }
    }
  }
}

func registerMediaHostPlugins(_ registry: HostPluginRegistry) {
  MediaHostPlugins.register(registry)
}
