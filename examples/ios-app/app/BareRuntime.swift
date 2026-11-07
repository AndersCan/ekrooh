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

  init() {
    // Storage in Application Support (excluded from backup; failing that is
    // fatal to the security model — a backed-up credential can leave the
    // device), cache in Caches, stale handoff removed. See `BareStorage`.
    let dirs: BareStorageDirectories
    do {
      dirs = try BareStorage.prepare()
    } catch {
      BareHostLogger.log("Failed to prepare worklet storage (backup exclusion)")
      self.handoffURL = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("handoff.json")
      self.worklet = nil
      self.ipc = nil
      ready = false
      return
    }
    self.handoffURL = dirs.handoff

    // The web app ships in the app bundle (Resources/WebAssets) and is served
    // by the worklet's loopback server; the storage dir transiently holds the
    // origin/bootstrap handoff file, deleted as soon as the host reads it.
    guard
      let webAssetsURL = Bundle.main.url(
        forResource: "WebAssets", withExtension: nil
      )
    else {
      fatalError("Missing WebAssets in app bundle — run `npm run build:ios` first.")
    }

    let configuration = Worklet.Configuration(
      memoryLimit: 128 << 20,
      // Disposable: lives with the cache (Caches/bare-cache), not in the
      // backed-up-excluded durable storage.
      assets: dirs.cache.appendingPathComponent("asset-cache").path
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
      arguments: [webAssetsURL.path, dirs.storage.path, dirs.cache.path]
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
  /// over the loopback WebSocket socket. Also installs the library's
  /// navigation delegate, which confines the WebView to the loopback origin.
  func attach(webView: WKWebView) {
    guard let ipc, attached == false, ready else { return }
    attached = true

    BareWebHost.configure(webView)
    let navDelegate = BareNavigationDelegate()
    self.navigationDelegate = navDelegate
    self.webView = webView
    webView.navigationDelegate = navDelegate

    let hostPlugins = HostPluginRegistry()
    registerDefaultHostPlugins(hostPlugins)
    registerMediaHostPlugins(hostPlugins)

    coordinator = HostIpcCoordinator(ipc: ipc, hostPlugins: hostPlugins)
    coordinator?.start()

    waitForHandoffAndLoad(webView: webView, delegate: navDelegate)
  }

  /// Polls the worklet's `handoff.json` (written once the loopback server is
  /// up), then injects the one-time bootstrap nonce + shell marker and loads
  /// the page (`BareWebHost.load`). The raw session token is never exposed to
  /// page JS — only the single-use nonce the page exchanges once via
  /// `POST /login`. `BareHandoff.consume` deletes the file as it reads it.
  ///
  /// Past the timeout a visible message replaces the blank page (UI tests use
  /// it to name the stalled stage), but polling continues: a slow cold boot
  /// still loads the app instead of leaving it dead with an unredeemed nonce
  /// on disk.
  private func waitForHandoffAndLoad(webView: WKWebView, delegate: BareNavigationDelegate) {
    let handoffURL = self.handoffURL
    handoffTask = Task { @MainActor in
      let deadline = Date().addingTimeInterval(Self.handoffTimeout)
      var timedOut = false
      while !Task.isCancelled {
        if let handoff = BareHandoff.consume(at: handoffURL) {
          BareWebHost.load(handoff, in: webView, delegate: delegate)
          return
        }
        if !timedOut && Date() >= deadline {
          timedOut = true
          BareHostLogger.log("Timed out waiting for worklet handoff; still polling")
          webView.loadHTMLString(
            "<p>Worklet handoff timed out after \(Int(Self.handoffTimeout))s</p>",
            baseURL: nil
          )
        }
        try? await Task.sleep(nanoseconds: timedOut ? 500_000_000 : 100_000_000)
      }
      // Cancelled (terminate): do not leave a nonce behind.
      try? FileManager.default.removeItem(at: handoffURL)
    }
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
    // Close the IPC channel first, then terminate the worklet, so the read
    // loop observes the close instead of a torn-down worklet. `close()` is
    // async on the IPC actor; the worklet is terminated after it returns.
    let ipcToClose = ipc
    let workletToTerminate = worklet
    ipc = nil
    worklet = nil
    Task {
      await ipcToClose?.close()
      workletToTerminate?.terminate()
    }
  }

  deinit {
    terminate()
  }
}
