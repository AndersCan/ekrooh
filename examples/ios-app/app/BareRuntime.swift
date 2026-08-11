import BareHost
import BareKit
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
  private let handoffURL: URL

  init() {
    let documents =
      FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    let storageDir = documents.appendingPathComponent("bare", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: storageDir, withIntermediateDirectories: true
    )
    self.handoffURL = storageDir.appendingPathComponent("handoff.json")
    // A previous run may have left a handoff file pointing at a dead ephemeral
    // port; remove it so polling never loads a stale origin.
    try? FileManager.default.removeItem(at: handoffURL)

    // The web app ships in the app bundle (Resources/WebAssets) and is served
    // by the worklet's loopback server; the storage dir holds the port/token
    // handoff file.
    guard
      let webAssetsURL = Bundle.main.url(
        forResource: "WebAssets", withExtension: nil
      )
    else {
      fatalError("Missing WebAssets in app bundle — run `npm run build:ios` first.")
    }

    let worklet = Worklet(
      configuration: Worklet.Configuration(
        memoryLimit: 128 << 20,
        assets: storageDir.appendingPathComponent("asset-cache").path
      )
    )
    worklet.start(
      name: "main.core",
      ofType: "bundle",
      inBundle: .main,
      arguments: [webAssetsURL.path, storageDir.path]
    )
    self.worklet = worklet
    self.ipc = IPC(worklet: worklet)
  }

  /// Attaches the web layer once the WKWebView exists. The coordinator handles
  /// host capability queries and invokes; the page itself talks to the worklet
  /// over the loopback WebSocket socket.
  func attach(webView: WKWebView) {
    guard let ipc, attached == false else { return }
    attached = true

    let hostPlugins = HostPluginRegistry()
    registerDefaultHostPlugins(hostPlugins)
    registerMediaHostPlugins(hostPlugins)

    coordinator = HostIpcCoordinator(ipc: ipc, hostPlugins: hostPlugins)
    coordinator?.start()

    waitForHandoffAndLoad(webView: webView)
  }

  /// Polls the worklet's `handoff.json` (written once the loopback server is
  /// up), injects the session token + shell marker, then loads the page.
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
        let token = credentials["token"] as? String,
        let url = URL(string: "\(origin)/index.html")
      else {
        BareHostLogger.log("Timed out waiting for worklet handoff")
        return
      }
      webView.configuration.userContentController.addUserScript(
        WKUserScript(
          source: "window.__lessBareToken='\(token)';window.BareShell=true;",
          injectionTime: .atDocumentStart,
          forMainFrameOnly: true
        )
      )
      webView.load(URLRequest(url: url))
    }
  }

  func terminate() {
    guard terminated == false else { return }
    terminated = true
    handoffTask?.cancel()
    handoffTask = nil
    coordinator = nil
    ipc?.close()
    ipc = nil
    worklet?.terminate()
    worklet = nil
  }

  deinit {
    terminate()
  }
}
