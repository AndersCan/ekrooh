import Foundation
import WebKit

/// Serves the packaged web app from the app bundle over a custom scheme — the
/// iOS equivalent of Android's `WebViewAssetLoader`.
///
/// A plain `file://` load cannot fetch Vite's `crossorigin` module scripts
/// (opaque file origin fails the CORS-mode fetch), so the same assets are
/// served over a custom scheme with correct MIME types, where same-origin
/// module requests succeed.
final class BareAssetSchemeHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "barehost"

  private let assetsURL: URL

  init(assetsURL: URL) {
    self.assetsURL = assetsURL
  }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else {
      task.didFailWithError(URLError(.badURL))
      return
    }

    let relative = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
    let fileURL = relative.isEmpty
      ? assetsURL.appendingPathComponent("index.html")
      : assetsURL.appendingPathComponent(relative)

    guard FileManager.default.fileExists(atPath: fileURL.path) else {
      task.didFailWithError(URLError(.fileDoesNotExist))
      return
    }
    guard let data = try? Data(contentsOf: fileURL) else {
      task.didFailWithError(URLError(.cannotOpenFile))
      return
    }

    let mime = Self.mimeType(for: fileURL.pathExtension)
    let response = URLResponse(
      url: url,
      mimeType: mime,
      expectedContentLength: data.count,
      textEncodingName: mime.hasPrefix("text/") ? "UTF-8" : nil
    )
    task.didReceive(response)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

  private static func mimeType(for ext: String) -> String {
    switch ext {
    case "html":
      return "text/html"
    case "js":
      return "text/javascript"
    case "css":
      return "text/css"
    case "json":
      return "application/json"
    case "svg":
      return "image/svg+xml"
    case "png":
      return "image/png"
    case "jpg", "jpeg":
      return "image/jpeg"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    case "woff":
      return "font/woff"
    case "woff2":
      return "font/woff2"
    default:
      return "application/octet-stream"
    }
  }
}
