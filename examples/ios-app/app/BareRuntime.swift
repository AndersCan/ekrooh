import BareHost
import BareKit
import SafariServices
import WebKit

/// Owns the full host lifecycle: the Bare worklet, the IPC channel, the host
/// plugin registry and the loopback page load. Mirror of `MainActivity.kt`.
final class BareRuntime {
  private var worklet: Worklet?
  private var ipc: IPC?
  private var coordinator: HostIpcCoordinator?
  private var handoffTask: Task<Void, Never>?
  private var attached = false
  private var terminated = false
  private var ready = true
  private let handoffURL: URL
  private var navigationDelegate: BareNavigationDelegate?
  private weak var webView: WKWebView?

  init() {
    let documents =
      FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    var storageDir = documents.appendingPathComponent("bare", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: storageDir, withIntermediateDirectories: true
    )
    // The storage dir transitly holds session credentials (handoff.json,
    // carrying the loopback bearer token); resolve the handoff path up front so
    // every early-return path below has all stored properties initialized.
    self.handoffURL = storageDir.appendingPathComponent("handoff.json")

    // The storage dir holds session credentials (handoff.json, carrying the
    // loopback bearer token); keep the whole dir out of iCloud/iTunes backups.
    // Failing here is fatal to the security model — a backed-up credential can
    // leave the device, so abort attach rather than degrade silently.
    var backupValues = URLResourceValues()
    backupValues.isExcludedFromBackup = true
    do {
      try storageDir.setResourceValues(backupValues)
    } catch {
      BareHostLogger.log("Failed to exclude storage directory from backups")
      self.worklet = nil
      self.ipc = nil
      ready = false
      return
    }

    // Ephemeral cache dir: kept outside the durable storage dir so the worklet
    // can treat it as disposable (asset cache, photo spool, temp).
    let bareCacheDir = documents.appendingPathComponent("bare-cache", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: bareCacheDir, withIntermediateDirectories: true
    )
    // A previous run may have left a handoff file pointing at a dead ephemeral
    // port; remove it so polling never loads a stale origin.
    try? FileManager.default.removeItem(at: handoffURL)

    // The web app ships in the app bundle (Resources/WebAssets) and is served
    // by the worklet's loopback server; the storage dir transiently holds the
    // port/token handoff file, deleted after the one-time page load.
    guard
      let webAssetsURL = Bundle.main.url(
        forResource: "WebAssets", withExtension: nil
      )
    else {
      fatalError("Missing WebAssets in app bundle — run `npm run build:ios` first.")
    }

    let configuration = Worklet.Configuration(
      memoryLimit: 128 << 20,
      assets: storageDir.appendingPathComponent("asset-cache").path
    )
    // The engine may fail to initialize (e.g. out of memory); degrade rather
    // than crash so the app stays alive without the worklet.
    guard let worklet = try? Worklet(configuration: configuration) else {
      BareHostLogger.log("Failed to initialize Bare worklet")
      self.worklet = nil
      self.ipc = nil
      ready = false
      return
    }
    worklet.start(
      name: "main.core",
      ofType: "bundle",
      inBundle: .main,
      // On-device argv contract: [webAssets, storage, cache] (see
      // `resolveWorkletConfig()`). All three must be directories; a
      // missing/absent cache falls back to storage with a warning, so pass a
      // real cache dir to keep boots quiet.
      arguments: [webAssetsURL.path, storageDir.path, bareCacheDir.path]
    )
    self.worklet = worklet

    do {
      self.ipc = try IPC(worklet: worklet)
    } catch {
      BareHostLogger.log("Failed to initialize Bare IPC")
      worklet.terminate()
      self.worklet = nil
      self.ipc = nil
      ready = false
      return
    }
  }

  /// Attaches the web layer once the WKWebView exists. The coordinator handles
  /// host capability queries and invokes; the page itself talks to the worklet
  /// over the loopback WebSocket socket. Also installs a navigation delegate
  /// that confines the WebView to the loopback origin.
  func attach(webView: WKWebView) {
    guard let ipc, attached == false, ready else { return }
    attached = true

    let navDelegate = BareNavigationDelegate()
    navDelegate.runtime = self
    self.navigationDelegate = navDelegate
    self.webView = webView
    webView.navigationDelegate = navDelegate

    let hostPlugins = HostPluginRegistry()
    registerDefaultHostPlugins(hostPlugins)
    registerMediaHostPlugins(hostPlugins)

    coordinator = HostIpcCoordinator(ipc: ipc, hostPlugins: hostPlugins)
    coordinator?.start()

    waitForHandoffAndLoad(webView: webView)
  }

  /// Polls the worklet's `handoff.json` (written once the loopback server is
  /// up), injects the one-time bootstrap nonce + shell marker, then loads the
  /// page. The raw session token is never exposed to page JS — only the
  /// single-use nonce the page exchanges once via `POST /login`.
  private func waitForHandoffAndLoad(webView: WKWebView) {
    handoffTask = Task { @MainActor in
      let deadline = Date().addingTimeInterval(15)
      var credentials: [String: Any]?
      while Date() < deadline && !Task.isCancelled {
        if let data = try? Data(contentsOf: handoffURL) {
          credentials =
            (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
          if credentials != nil { break }
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      guard
        !Task.isCancelled,
        let credentials,
        let origin = credentials["origin"] as? String,
        let bootstrap = credentials["bootstrap"] as? String,
        let url = URL(string: "\(origin)/index.html")
      else {
        BareHostLogger.log("Timed out waiting for worklet handoff")
        return
      }
      // Confine the WebView to exactly this loopback origin (host + port); any
      // other main-frame navigation is cancelled (and external URLs bounced to
      // the system browser by the navigation delegate).
      if let originURL = URL(string: origin) {
        navigationDelegate?.allowedHost = originURL.host
        navigationDelegate?.allowedPort = originURL.port
      }
      webView.configuration.userContentController.addUserScript(
        WKUserScript(
          source: "window.__ekrooh={bootstrap:\(bootstrapJSON(bootstrap))};window.BareShell=true;",
          injectionTime: .atDocumentStart,
          forMainFrameOnly: true
        )
      )
      webView.load(URLRequest(url: url))
      // The bootstrap is single-use in core and the token is a bearer
      // credential; the handoff file is not needed after this one load (the
      // page keeps its own HttpOnly session cookie). Core regenerates the
      // credentials on the next boot, so drop them from disk now.
      try? FileManager.default.removeItem(at: handoffURL)
    }
  }

  /// JSON-encodes the bootstrap so an arbitrary value cannot break out of the
  /// injected JS string literal (quotes, backslashes and control chars escaped).
  private func bootstrapJSON(_ value: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data()
    return String(data: data, encoding: .utf8) ?? "\"\""
  }

  /// Removes the injected bootstrap user script so the single-use nonce cannot
  /// be re-injected into a later navigation. Called once after the first page
  /// load finishes.
  fileprivate func consumeBootstrapOnce() {
    guard let webView else { return }
    webView.configuration.userContentController.removeAllUserScripts()
  }

  /// Suspends the worklet when the app is backgrounded.
  func suspend() {
    worklet?.suspend(linger: 0)
  }

  /// Resumes the worklet when the app returns to the foreground.
  func resume() {
    worklet?.resume()
  }

  func terminate() {
    guard terminated == false else { return }
    terminated = true
    handoffTask?.cancel()
    handoffTask = nil
    coordinator = nil
    // `close()` is asynchronous on the IPC actor; capture the reference so the
    // in-flight read loop observes the close instead of a torn-down channel.
    let ipcToClose = ipc
    Task { await ipcToClose?.close() }
    ipc = nil
    worklet?.terminate()
    worklet = nil
  }

  deinit {
    terminate()
  }
}

/// Restricts the WebView to the loopback origin handed off by the worklet.
/// Mirrors Android's `allowedOriginRules`: any main-frame navigation to a host
/// or port other than the loopback server is cancelled, and external http(s)
/// URLs are opened in the system browser instead of inside the trusted view.
final class BareNavigationDelegate: NSObject, WKNavigationDelegate {
  weak var runtime: BareRuntime?
  var allowedHost: String?
  var allowedPort: Int?

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    // Sub-frame / non-main navigations are permitted (e.g. assets, sockets).
    guard navigationAction.targetFrame?.isMainFrame == true else {
      decisionHandler(.allow)
      return
    }
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    let host = components?.host ?? ""
    let port = components?.port ?? (url.scheme == "https" ? 443 : 80)
    if host == allowedHost && port == allowedPort {
      decisionHandler(.allow)
      return
    }
    // Off-loopback navigation: bounce external URLs to the system browser
    // rather than rendering them inside the trusted WebView.
    if url.scheme == "http" || url.scheme == "https" {
      decisionHandler(.cancel)
      if UIApplication.shared.canOpenURL(url) {
        UIApplication.shared.open(url)
      }
      return
    }
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    runtime?.consumeBootstrapOnce()
  }
}
