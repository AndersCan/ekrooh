import BareHost
import BareKit
import WebKit

/// Owns the full host lifecycle: the Bare worklet, the IPC channel, the host
/// plugin registry and the WKWebView bridge. Mirror of `MainActivity.kt`.
final class BareRuntime {
  private var worklet: Worklet?
  private var ipc: IPC?
  private var bridge: BareWebViewBridge?
  private var coordinator: HostIpcCoordinator?

  init() {
    // Same memory limit as the Android reference app.
    let worklet = Worklet(
      configuration: Worklet.Configuration(memoryLimit: 128 << 20)
    )
    worklet.start(name: "main.core", ofType: "bundle", inBundle: .main)
    self.worklet = worklet
    self.ipc = IPC(worklet: worklet)
  }

  /// Attaches the web layer once the WKWebView exists. The coordinator relays
  /// non-host envelopes to the web layer as the original bytes.
  func attach(webView: WKWebView) {
    guard let ipc else { return }

    let bridge = BareWebViewBridge(webView: webView) { [weak self] frame in
      guard let ipc = self?.ipc else { return }
      Task { try? await ipc.write(data: frame) }
    }
    self.bridge = bridge

    let hostPlugins = HostPluginRegistry()
    registerDefaultHostPlugins(hostPlugins)
    registerMediaHostPlugins(hostPlugins)

    coordinator = HostIpcCoordinator(
      ipc: ipc,
      hostPlugins: hostPlugins,
      relayToWebView: { [weak bridge] bytes in bridge?.push(bytes) }
    )
    coordinator?.start()
  }

  func terminate() {
    coordinator = nil
    bridge = nil
    ipc?.close()
    ipc = nil
    worklet?.terminate()
    worklet = nil
  }

  deinit {
    terminate()
  }
}
