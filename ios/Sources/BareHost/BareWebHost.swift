import Foundation
import UIKit
import WebKit

// The pieces of a host shell that enforce docs/security.md §5 on iOS, shipped
// in the library so a consumer app gets them by calling them instead of
// re-implementing them (the reference app, `examples/ios-app`, uses exactly
// these):
//
// - `BareStorage.prepare()`: storage outside Documents, excluded from backup.
// - `BareHandoff.consume(at:)`: reads `handoff.json` and deletes it.
// - `BareNavigationDelegate`: confines the WebView to the loopback origin.
// - `BareWebHost.configure(_:)` / `.load(_:in:delegate:)`: WebView hardening
//   and the one-time bootstrap injection.

// MARK: - Storage

/// The worklet's sandbox directories (argv `[webAssets, storage, cache]`).
public struct BareStorageDirectories: Equatable {
  /// Durable storage (`handoff.json`, the p2p corestore), excluded from backup.
  public let storage: URL
  /// Disposable cache, under the system Caches directory.
  public let cache: URL
  /// Where the worklet writes the origin + bootstrap handoff.
  public var handoff: URL { storage.appendingPathComponent("handoff.json") }
}

public enum BareStorageError: Error {
  case noApplicationSupportDirectory
  /// The storage directory could not be excluded from backup. A backed-up
  /// credential can leave the device, so the host must not start.
  case backupExclusionFailed(Error)
}

public enum BareStorage {
  /// Creates the worklet directories, excludes storage from iCloud/iTunes
  /// backup (throws if that fails), and deletes a stale `handoff.json`.
  ///
  /// Storage lives in `Application Support/bare` (never shown in the Files app,
  /// even if the app turns on file sharing); the cache in `Caches/bare-cache`
  /// (not backed up, purgeable). A `Documents/bare` left by an older version is
  /// moved over once.
  public static func prepare(fileManager: FileManager = .default) throws -> BareStorageDirectories {
    guard
      let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
      let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
    else { throw BareStorageError.noApplicationSupportDirectory }
    let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
    return try prepare(
      applicationSupport: support, caches: caches,
      legacyStorage: documents?.appendingPathComponent("bare", isDirectory: true),
      fileManager: fileManager)
  }

  /// `prepare()` with explicit roots (tests).
  public static func prepare(
    applicationSupport: URL,
    caches: URL,
    legacyStorage: URL?,
    fileManager: FileManager = .default
  ) throws -> BareStorageDirectories {
    var storage = applicationSupport.appendingPathComponent("bare", isDirectory: true)
    let cache = caches.appendingPathComponent("bare-cache", isDirectory: true)
    try fileManager.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
    if let legacyStorage, fileManager.fileExists(atPath: legacyStorage.path) {
      migrate(from: legacyStorage, to: storage, fileManager: fileManager)
    }
    try fileManager.createDirectory(at: storage, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: cache, withIntermediateDirectories: true)

    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
      try storage.setResourceValues(values)
    } catch {
      throw BareStorageError.backupExclusionFailed(error)
    }
    // Caches is never backed up; flag it anyway in case a consumer moves it.
    var cacheURL = cache
    try? cacheURL.setResourceValues(values)

    let dirs = BareStorageDirectories(storage: storage, cache: cache)
    // A previous run may have left a handoff pointing at a dead port.
    try? fileManager.removeItem(at: dirs.handoff)
    return dirs
  }

  /// Moves a `Documents/bare` left by an older version into `storage`. Keyed
  /// on the legacy directory existing, so a move that fails (or is cut short)
  /// is retried on the next launch: entries already present in `storage` are
  /// kept, the rest are moved one by one, and the legacy directory is removed
  /// once empty. While anything is left behind it is logged and excluded from
  /// backup, so the old copy never leaves the device either.
  static func migrate(from legacy: URL, to storage: URL, fileManager: FileManager) {
    var failed = false
    if !fileManager.fileExists(atPath: storage.path) {
      do {
        try fileManager.moveItem(at: legacy, to: storage)
        return
      } catch {
        failed = true
      }
    }
    if !failed || fileManager.fileExists(atPath: storage.path) {
      let entries = (try? fileManager.contentsOfDirectory(atPath: legacy.path)) ?? []
      for name in entries {
        let target = storage.appendingPathComponent(name)
        if fileManager.fileExists(atPath: target.path) { continue }
        do {
          try fileManager.moveItem(at: legacy.appendingPathComponent(name), to: target)
        } catch {
          failed = true
        }
      }
    }
    let remaining = (try? fileManager.contentsOfDirectory(atPath: legacy.path)) ?? []
    let leftOver = remaining.filter {
      !fileManager.fileExists(atPath: storage.appendingPathComponent($0).path)
    }
    if leftOver.isEmpty && !failed {
      try? fileManager.removeItem(at: legacy)
      return
    }
    BareHostLogger.log("Storage migration from Documents incomplete; retrying next launch")
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var legacyURL = legacy
    try? legacyURL.setResourceValues(values)
  }
}

// MARK: - Handoff

/// The worklet's `handoff.json`: the loopback origin and the single-use
/// bootstrap nonce (never the session token).
public struct BareHandoff: Equatable {
  /// `http://127.0.0.1:<port>`, exactly.
  public let origin: String
  public let port: Int
  public let bootstrap: String

  public var host: String { "127.0.0.1" }
  public var pageURL: URL { URL(string: "\(origin)/index.html")! }

  /// Parses a handoff. Only a loopback origin (`http://127.0.0.1:<port>`) and
  /// a base64url nonce of at most 256 characters are accepted, so both are
  /// safe to embed in a script and the WebView can only be pointed at the
  /// loopback server.
  public static func parse(_ data: Data) -> BareHandoff? {
    guard
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let origin = object["origin"] as? String,
      let bootstrap = object["bootstrap"] as? String
    else { return nil }
    let prefix = "http://127.0.0.1:"
    guard origin.hasPrefix(prefix) else { return nil }
    let portText = origin.dropFirst(prefix.count)
    guard (1...5).contains(portText.count), portText.allSatisfy({ ("0"..."9").contains($0) }),
      let port = Int(portText), (1...65535).contains(port)
    else { return nil }
    let base64url = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    guard (1...256).contains(bootstrap.count), bootstrap.allSatisfy({ base64url.contains($0) })
    else { return nil }
    return BareHandoff(origin: origin, port: port, bootstrap: bootstrap)
  }

  /// Reads and parses the handoff at `url`, then deletes the file: the nonce
  /// is single-use, so it does not stay on disk once the host holds it.
  /// Returns `nil` (and leaves the file) while it is missing or not yet a
  /// complete, valid handoff.
  public static func consume(at url: URL, fileManager: FileManager = .default) -> BareHandoff? {
    guard let data = try? Data(contentsOf: url), let handoff = parse(data) else { return nil }
    try? fileManager.removeItem(at: url)
    return handoff
  }

  /// Script that sets `window.__ekrooh = { bootstrap }` and
  /// `window.BareShell = true`, only when the document's origin is this
  /// handoff's origin. JSON-encoded, so no value can break out of the literal.
  public var bootstrapScriptSource: String {
    let payload = BareProtocol.encodeJSON(["bootstrap": bootstrap])
    let originLiteral = BareProtocol.encodeJSON([origin]).dropFirst().dropLast()
    return
      "if (location.origin === \(originLiteral)) { window.__ekrooh = \(payload); window.BareShell = true; }"
  }

  /// The bootstrap as a document-start, main-frame-only user script.
  public func bootstrapUserScript() -> WKUserScript {
    WKUserScript(
      source: bootstrapScriptSource,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true
    )
  }
}

// MARK: - Navigation confinement

public enum BareNavigationDecision: Equatable {
  case allow
  case cancel
  /// Cancel in the WebView and hand the URL to the system browser.
  case openExternally
  /// A new-window request (`target=_blank`, `window.open`) for the app's own
  /// origin: there is no second window, so load it in this one.
  case loadInPlace
}

/// The pure decision behind `BareNavigationDelegate` (unit-tested).
public struct BareNavigationPolicy: Equatable {
  /// Loopback host and port the WebView may show. `nil` until the handoff:
  /// then only `about:blank` (an `loadHTMLString` status page) is allowed.
  public var allowedHost: String?
  public var allowedPort: Int?
  /// Subframes may load off-origin URLs. Off by default: the app's CSP
  /// (`default-src 'self'`) refuses them anyway, and this keeps a relaxed
  /// consumer CSP from silently widening what the trusted view loads.
  public var allowsForeignSubframes: Bool

  public init(allowedHost: String? = nil, allowedPort: Int? = nil, allowsForeignSubframes: Bool = false) {
    self.allowedHost = allowedHost
    self.allowedPort = allowedPort
    self.allowsForeignSubframes = allowsForeignSubframes
  }

  public init(handoff: BareHandoff) {
    self.init(allowedHost: handoff.host, allowedPort: handoff.port)
  }

  /// `true` for `http://<allowedHost>:<allowedPort>/…` with no user info.
  public func isAppURL(_ url: URL) -> Bool {
    guard let allowedHost, let allowedPort,
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return false }
    return components.scheme?.lowercased() == "http"
      && components.host == allowedHost
      && components.port == allowedPort
      && components.user == nil && components.password == nil
  }

  /// - Parameters:
  ///   - isMainFrame: the navigation targets the main frame.
  ///   - isNewWindow: it targets no frame (`target=_blank`, `window.open`).
  ///   - isLinkActivated: the user activated a link (not a redirect, a
  ///     script or a `<meta refresh>`).
  public func decide(
    url: URL?, isMainFrame: Bool, isNewWindow: Bool, isLinkActivated: Bool
  ) -> BareNavigationDecision {
    guard let url else { return .cancel }
    let isBlank = url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc"
    let isWeb = ["http", "https"].contains(url.scheme?.lowercased() ?? "")

    if isNewWindow {
      // There is no second window. The app's own pages load in this one; a
      // link the user activated to another site goes to the system browser;
      // everything else is dropped.
      if isAppURL(url) { return .loadInPlace }
      return isWeb && isLinkActivated ? .openExternally : .cancel
    }
    if !isMainFrame {
      if isBlank || isAppURL(url) || (allowsForeignSubframes && isWeb) { return .allow }
      return .cancel
    }
    if isAppURL(url) || url.absoluteString == "about:blank" { return .allow }
    // Off-loopback: never render it in the trusted view. Only a link the user
    // activated opens the system browser, so a redirect or script cannot
    // launch Safari on its own.
    return isWeb && isLinkActivated ? .openExternally : .cancel
  }
}

/// Restricts a WKWebView to the loopback origin handed off by the worklet.
/// Mirror of Android's `BareWebViewClient`: main-frame navigations to any
/// other origin are cancelled; links the user activates to other http(s)
/// sites open in the system browser instead of inside the trusted view.
open class BareNavigationDelegate: NSObject, WKNavigationDelegate {
  public var policy: BareNavigationPolicy
  /// Opens an off-origin URL outside the app. Defaults to the system browser.
  public var openExternally: (URL) -> Void = { url in
    UIApplication.shared.open(url)
  }
  /// Called after every finished main-frame load.
  public var onPageLoaded: (() -> Void)?

  public init(policy: BareNavigationPolicy = BareNavigationPolicy()) {
    self.policy = policy
  }

  /// Allows exactly the handoff's origin from now on.
  public func confine(to handoff: BareHandoff) {
    policy.allowedHost = handoff.host
    policy.allowedPort = handoff.port
  }

  open func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = navigationAction.request.url
    let decision = policy.decide(
      url: url,
      isMainFrame: navigationAction.targetFrame?.isMainFrame == true,
      isNewWindow: navigationAction.targetFrame == nil,
      isLinkActivated: navigationAction.navigationType == .linkActivated
    )
    switch decision {
    case .allow:
      decisionHandler(.allow)
    case .cancel:
      decisionHandler(.cancel)
    case .openExternally:
      decisionHandler(.cancel)
      if let url { openExternally(url) }
    case .loadInPlace:
      decisionHandler(.cancel)
      webView.load(navigationAction.request)
    }
  }

  open func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    onPageLoaded?()
  }
}

// MARK: - WebView

public enum BareWebHost {
  /// Hardens a WKWebView for the trusted app view: no link previews (they
  /// would render off-origin pages in-app, outside the navigation delegate)
  /// and not inspectable (iOS 16.4+ default, made explicit).
  public static func configure(_ webView: WKWebView) {
    webView.allowsLinkPreview = false
    if #available(iOS 16.4, *) {
      webView.isInspectable = false
    }
  }

  /// Confines `webView` to the handoff's origin, injects the bootstrap for
  /// the first page only, and loads `/index.html`. The user script is
  /// removed (with any other user scripts) once that page has loaded, so a
  /// later navigation never gets the nonce again.
  public static func load(
    _ handoff: BareHandoff, in webView: WKWebView, delegate: BareNavigationDelegate
  ) {
    delegate.confine(to: handoff)
    webView.navigationDelegate = delegate
    let controller = webView.configuration.userContentController
    controller.addUserScript(handoff.bootstrapUserScript())
    let previous = delegate.onPageLoaded
    delegate.onPageLoaded = { [weak controller, weak delegate] in
      controller?.removeAllUserScripts()
      delegate?.onPageLoaded = previous
      previous?()
    }
    webView.load(URLRequest(url: handoff.pageURL))
  }
}
