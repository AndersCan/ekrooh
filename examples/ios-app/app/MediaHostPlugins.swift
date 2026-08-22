import BareHost
import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Reference host handlers for `vendor.media` (the worklet's loopback HTTP
/// server serves the returned path to the web layer — no bytes on the wire).
/// Real picker + camera: `PHPickerViewController` for pick (out-of-process, no
/// photo-library permission), `UIImagePickerController` for capture. The picked
/// or captured file is copied to a temp path the worklet can serve; a file
/// extension is always preserved/derived so the loopback server can set the
/// content type. Simulators report a deterministic "camera unavailable" error
/// (`UIImagePickerController.isSourceTypeAvailable(.camera)` is false).
enum MediaHostPlugins {
  static func register(_ registry: HostPluginRegistry) {
    registry.register(pluginId: "vendor.media", event: "media.pick") { args, _, respond in
      MediaHostPlugins.pick(kind: Self.kind(from: args), respond: respond)
    }
    registry.register(pluginId: "vendor.media", event: "media.capture") { args, _, respond in
      MediaHostPlugins.capture(kind: Self.kind(from: args), respond: respond)
    }
  }

  private static func kind(from args: [String: Any]?) -> String {
    (args?["kind"] as? String) ?? "image"
  }

  private static func pick(
    kind: String,
    respond: @escaping (HostPluginRegistry.HostInvokeOutcome) -> Void
  ) {
    Task { @MainActor in
      var config = PHPickerConfiguration(photoLibrary: .shared())
      config.filter = kind == "video" ? .videos : .images
      config.selectionLimit = 1
      let picker = PHPickerViewController(configuration: config)
      let controller = MediaPickerController(kind: kind, respond: respond)
      picker.delegate = controller
      guard let top = Self.topViewController() else {
        respond(
          .fail(code: ErrorCodes.hostError, message: "No view controller to present from")
        )
        return
      }
      Self.retain(controller)
      top.present(picker, animated: true)
    }
  }

  private static func capture(
    kind: String,
    respond: @escaping (HostPluginRegistry.HostInvokeOutcome) -> Void
  ) {
    Task { @MainActor in
      #if targetEnvironment(simulator)
      // Simulators have no camera — deterministic, testable failure regardless
      // of isSourceTypeAvailable (newer simulators report a camera).
      respond(.fail(code: ErrorCodes.hostError, message: "camera unavailable"))
      #else
      guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
        respond(.fail(code: ErrorCodes.hostError, message: "camera unavailable"))
        return
      }
      guard let top = Self.topViewController() else {
        respond(
          .fail(code: ErrorCodes.hostError, message: "No view controller to present from")
        )
        return
      }
      let picker = UIImagePickerController()
      picker.sourceType = .camera
      picker.mediaTypes =
        kind == "video" ? [UTType.movie.identifier] : [UTType.image.identifier]
      let controller = MediaPickerController(kind: kind, respond: respond)
      picker.delegate = controller
      Self.retain(controller)
      top.present(picker, animated: true)
      #endif
    }
  }

  private static func topViewController() -> UIViewController? {
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes
      where scene.activationState == .foregroundActive {
      var top = scene.windows.first { $0.isKeyWindow }?.rootViewController
      while let presented = top?.presentedViewController {
        top = presented
      }
      return top
    }
    return nil
  }

  private static var active = Set<MediaPickerController>()

  fileprivate static func retain(_ controller: MediaPickerController) {
    active.insert(controller)
  }

  fileprivate static func release(_ controller: MediaPickerController) {
    active.remove(controller)
  }
}

func registerMediaHostPlugins(_ registry: HostPluginRegistry) {
  MediaHostPlugins.register(registry)
}

/// Retains the respond closure until the native picker/camera finishes, then
/// stages the result as a temp file and responds with its path. Kept strongly
/// referenced by `MediaHostPlugins.active` because UIKit delegates are weak.
private final class MediaPickerController: NSObject, PHPickerViewControllerDelegate,
  UIImagePickerControllerDelegate, UINavigationControllerDelegate
{
  private let kind: String
  private let respond: (HostPluginRegistry.HostInvokeOutcome) -> Void

  init(kind: String, respond: @escaping (HostPluginRegistry.HostInvokeOutcome) -> Void) {
    self.kind = kind
    self.respond = respond
  }

  private func abort(_ message: String) {
    respond(.fail(code: ErrorCodes.hostError, message: message))
    MediaHostPlugins.release(self)
  }

  private func finish(_ path: URL) {
    respond(.ok(["path": path.path]))
    MediaHostPlugins.release(self)
  }

  private func stage(from source: URL) -> URL? {
    let ext =
      source.pathExtension.isEmpty
      ? (kind == "video" ? "mov" : "heic") : source.pathExtension
    let dest = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("media-\(UUID().uuidString).\(ext)")
    do {
      try FileManager.default.copyItem(at: source, to: dest)
      return dest
    } catch {
      return nil
    }
  }

  // MARK: - PHPickerViewControllerDelegate

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard let result = results.first else {
      abort("No item selected")
      return
    }
    let type = kind == "video" ? UTType.movie.identifier : UTType.image.identifier
    result.itemProvider.loadFileRepresentation(forTypeIdentifier: type) {
      [weak self] url, error in
      guard let self else { return }
      guard let url, error == nil else {
        self.abort("Failed to load picked file")
        return
      }
      guard let dest = self.stage(from: url) else {
        self.abort("Failed to stage picked file")
        return
      }
      self.finish(dest)
    }
  }

  // MARK: - UIImagePickerControllerDelegate

  func imagePickerController(
    _ picker: UIImagePickerController,
    didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
  ) {
    picker.dismiss(animated: true)
    if kind == "video" {
      guard let url = info[.mediaURL] as? URL, let dest = stage(from: url) else {
        abort("Failed to stage captured video")
        return
      }
      finish(dest)
      return
    }
    guard let image = info[.originalImage] as? UIImage else {
      abort("No captured image")
      return
    }
    let dest = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("media-\(UUID().uuidString).jpg")
    guard
      let data = image.jpegData(compressionQuality: 0.9),
      (try? data.write(to: dest)) != nil
    else {
      abort("Failed to stage captured image")
      return
    }
    finish(dest)
  }

  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true)
    abort("Capture cancelled")
  }
}
