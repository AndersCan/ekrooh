import BareHost
import SwiftUI
import WebKit

struct ContentView: View {
  let runtime: BareRuntime

  var body: some View {
    BareWebView(runtime: runtime)
      .ignoresSafeArea()
  }
}

/// Full-screen WKWebView. The page is served by the worklet's loopback HTTP
/// server (URL loaded after the port/token handoff in `BareRuntime`).
struct BareWebView: UIViewRepresentable {
  let runtime: BareRuntime

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    let webView = WKWebView(frame: .zero, configuration: configuration)

    runtime.attach(webView: webView)

    return webView
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {}
}
