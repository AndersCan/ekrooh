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
  private var probeTask: Task<Void, Never>?
  private var webAssetsPath = ""
  private var storagePath = ""
  private var cachePath = ""
  private var attached = false
  private var terminated = false
  private var ready = true
  private let handoffURL: URL
  private var navigationDelegate: BareNavigationDelegate?
  private weak var webView: WKWebView?

  /// Debug builds (CI) get a longer handoff window for slow cold simulator
  /// boots; release keeps 15s, matching the Android host. A timeout renders a
  /// visible message so UI tests can tell this stage from a blank page. Debug
  /// builds accept `-ekroohHandoffTimeoutSeconds N` to force the timeout path.
  #if DEBUG
  private static let handoffTimeout: TimeInterval =
    UserDefaults.standard.object(forKey: "ekroohHandoffTimeoutSeconds") != nil
    ? UserDefaults.standard.double(forKey: "ekroohHandoffTimeoutSeconds") : 45
  #else
  private static let handoffTimeout: TimeInterval = 15
  #endif

  #if DEBUG
  // With `npm run dev` running, the debug app loads the page from Vite and runs
  // its backend in dev mode. The page port must match scripts/dev.mjs; the
  // backend port must stay free of the Mac's dev backends (8080, 8081).
  private static let devServerHost = "127.0.0.1"
  private static let devServerPort = 5173
  private static let devServerURL = "http://\(devServerHost):\(devServerPort)"
  private static let devBackendPort = 8082
  #endif

  init() {
    let documents =
      FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    var storageDir = documents.appendingPathComponent("bare", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: storageDir, withIntermediateDirectories: true
    )
    // The storage dir transiently holds handoff.json (origin + single-use
    // bootstrap nonce); resolve the handoff path up front so every
    // early-return path below has all stored properties initialized.
    self.handoffURL = storageDir.appendingPathComponent("handoff.json")

    // The storage dir holds handoff.json (a bootstrap nonce) and the p2p
    // corestore; keep the whole dir out of iCloud/iTunes backups. Failing here
    // is fatal to the security model — a backed-up credential can leave the
    // device, so abort attach rather than degrade silently.
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
    // origin/bootstrap handoff file, deleted after the one-time page load.
    guard
      let webAssetsURL = Bundle.main.url(
        forResource: "WebAssets", withExtension: nil
      )
    else {
      fatalError("Missing WebAssets in the app bundle. Run \"npm run sync\" first.")
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
    self.worklet = worklet
    self.webAssetsPath = webAssetsURL.path
    self.storagePath = storageDir.path
    self.cachePath = bareCacheDir.path
  }

  /// Attaches the web layer once the WKWebView exists. The coordinator handles
  /// host capability queries and invokes; the page itself talks to the worklet
  /// over the loopback WebSocket socket. Also installs a navigation delegate
  /// that confines the WebView to the loopback origin.
  func attach(webView: WKWebView) {
    guard worklet != nil, attached == false, ready else { return }
    attached = true

    let navDelegate = BareNavigationDelegate()
    navDelegate.runtime = self
    self.navigationDelegate = navDelegate
    self.webView = webView
    webView.navigationDelegate = navDelegate

    #if DEBUG
    probeTask = Task { @MainActor in
      if Task.isCancelled { return }
      if await Self.devServerAnswers() {
        startDev(webView: webView)
      } else {
        startBundled(webView: webView)
      }
    }
    #else
    startBundled(webView: webView)
    #endif
  }

  /// Starts the worklet, the IPC channel and the host plugin coordinator.
  /// Returns false (and leaves no worklet) when the IPC channel cannot start.
  private func startWorklet(_ arguments: [String]) -> Bool {
    guard let worklet else { return false }
    worklet.start(
      name: "main.core",
      ofType: "bundle",
      inBundle: .main,
      arguments: arguments
    )
    do {
      self.ipc = try IPC(worklet: worklet)
    } catch {
      BareHostLogger.log("Failed to initialize Bare IPC")
      worklet.terminate()
      self.worklet = nil
      self.ipc = nil
      return false
    }
    guard let ipc else { return false }
    let hostPlugins = HostPluginRegistry()
    registerDefaultHostPlugins(hostPlugins)
    coordinator = HostIpcCoordinator(ipc: ipc, hostPlugins: hostPlugins)
    coordinator?.start()
    return true
  }

  private func startBundled(webView: WKWebView) {
    // On-device argv contract: [webAssets, storage, cache] (see
    // `resolveWorkletConfig()`). All three must be directories; a
    // missing/absent cache falls back to storage with a warning, so pass a
    // real cache dir to keep boots quiet.
    guard startWorklet([webAssetsPath, storagePath, cachePath]) else { return }
    waitForHandoffAndLoad(webView: webView)
  }

  #if DEBUG
  private func startDev(webView: WKWebView) {
    guard
      startWorklet([
        "webassets=\(webAssetsPath)", "storage=\(storagePath)", "cache=\(cachePath)",
        "mode=dev", "port=\(Self.devBackendPort)", "origin=\(Self.devServerURL)",
      ])
    else { return }
    navigationDelegate?.allowedHost = Self.devServerHost
    navigationDelegate?.allowedPort = Self.devServerPort
    if let url = URL(string: "\(Self.devServerURL)/?backend=\(Self.devBackendPort)") {
      webView.load(URLRequest(url: url))
    }
  }

  /// True when `npm run dev` answers on the dev server URL.
  private static func devServerAnswers() async -> Bool {
    guard let url = URL(string: "\(devServerURL)/@vite/client") else { return false }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 2
    let session = URLSession(configuration: configuration)
    return await withCheckedContinuation { continuation in
      session.dataTask(with: url) { _, response, error in
        continuation.resume(
          returning: error == nil && (response as? HTTPURLResponse)?.statusCode == 200
        )
      }.resume()
    }
  }
  #endif

  /// Polls the worklet's `handoff.json` (written once the loopback server is
  /// up), injects the one-time bootstrap nonce + shell marker, then loads the
  /// page. The raw session token is never exposed to page JS — only the
  /// single-use nonce the page exchanges once via `POST /login`.
  private func waitForHandoffAndLoad(webView: WKWebView) {
    handoffTask = Task { @MainActor in
      let deadline = Date().addingTimeInterval(Self.handoffTimeout)
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
        if !Task.isCancelled {
          webView.loadHTMLString(
            "<p>Worklet handoff timed out after \(Int(Self.handoffTimeout))s</p>",
            baseURL: nil
          )
        }
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
          source: "window.__ekrooh=\(bridgePayloadJSON(bootstrap));window.BareShell=true;",
          injectionTime: .atDocumentStart,
          forMainFrameOnly: true
        )
      )
      webView.load(URLRequest(url: url))
      // The bootstrap is single-use in core; the handoff file is not needed
      // after this one load (the page keeps its own HttpOnly session cookie).
      // Core regenerates it on the next boot, so drop it from disk now.
      try? FileManager.default.removeItem(at: handoffURL)
    }
  }

  /// JSON-encodes the bridge payload (`{"bootstrap":"…"}`) so an arbitrary
  /// bootstrap value cannot break out of the script string literal (quotes,
  /// backslashes and control chars escaped). The page transport requires
  /// `bootstrap` to be a *string* — serializing a bare value here would need
  /// an array wrapper, and `bootstrap:["…"]` silently skips the page login.
  private func bridgePayloadJSON(_ bootstrap: String) -> String {
    let data =
      (try? JSONSerialization.data(withJSONObject: ["bootstrap": bootstrap]))
      ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
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
    probeTask?.cancel()
    probeTask = nil
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
    // The handoff-timeout message is loaded via loadHTMLString (about:blank).
    if url.absoluteString == "about:blank" {
      decisionHandler(.allow)
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
