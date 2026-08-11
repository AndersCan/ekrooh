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

/// Full-screen WKWebView serving the reference web app from the app bundle
/// (the iOS equivalent of Android's `WebViewAssetLoader`).
struct BareWebView: UIViewRepresentable {
  let runtime: BareRuntime

  func makeUIView(context: Context) -> WKWebView {
    guard
      let assetsURL = Bundle.main.url(
        forResource: "WebAssets",
        withExtension: nil
      )
    else {
      fatalError("Missing WebAssets in app bundle — run npm run build:ios first")
    }

    let configuration = WKWebViewConfiguration()
    configuration.setURLSchemeHandler(
      BareAssetSchemeHandler(assetsURL: assetsURL),
      forURLScheme: BareAssetSchemeHandler.scheme
    )
    let webView = WKWebView(frame: .zero, configuration: configuration)

    runtime.attach(webView: webView)

    guard
      let url = URL(string: "\(BareAssetSchemeHandler.scheme)://web/index.html")
    else {
      fatalError("Invalid web app URL")
    }
    webView.load(URLRequest(url: url))

    return webView
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {}
}
