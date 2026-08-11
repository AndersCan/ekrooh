import Foundation
import WebKit

/**
 * Carries framed messages between the WKWebView and the Bare IPC channel.
 *
 * WKWebView has no `WebMessagePort` (the Android equivalent), so frames travel
 * as **base64-encoded strings** in both directions:
 *
 * - Web → worklet: the page posts frames via
 *   `window.webkit.messageHandlers.bareHost.postMessage(<base64>)`; this class
 *   decodes them and forwards the raw bytes to the IPC channel.
 * - worklet → Web: [push] relays the **original frame bytes** base64-encoded
 *   through the injected `window.onBareMessage(<base64>)` callback — no
 *   re-parse, no re-serialization.
 *
 * The frame bytes themselves are identical to every other transport; only the
 * carrier encodes (mirrors the Android API<34 base64 fallback exactly).
 */
public final class BareWebViewBridge: NSObject {
  /// Injected at document start so the native side can always call
  /// `window.onBareMessage`; early frames are buffered until the page
  /// transport installs its handler and drains them.
  private static let injectedScriptSource = """
    (function () {
      var pending = [];
      window.__lessBarePending = pending;
      window.onBareMessage = function (frame) {
        var binary = atob(frame);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        pending.push(bytes);
      };
    })();
    """

  private weak var webView: WKWebView?
  /// Forwards a decoded web → worklet frame to the IPC channel.
  private let forwardToIpc: (Data) -> Void

  public init(webView: WKWebView, forwardToIpc: @escaping (Data) -> Void) {
    self.webView = webView
    self.forwardToIpc = forwardToIpc
    super.init()
    webView.configuration.userContentController.addUserScript(
      WKUserScript(
        source: BareWebViewBridge.injectedScriptSource,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
      )
    )
    webView.configuration.userContentController.add(self, name: "bareHost")
  }

  deinit {
    webView?.configuration.userContentController.removeScriptMessageHandler(
      forName: "bareHost"
    )
  }

  /// Relays a worklet → web frame. Safe to call from any thread.
  public func push(_ data: Data) {
    let base64 = data.base64EncodedString()
    DispatchQueue.main.async {
      self.webView?.evaluateJavaScript("window.onBareMessage('\(base64)')")
    }
  }
}

extension BareWebViewBridge: WKScriptMessageHandler {
  public func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    guard message.name == "bareHost" else { return }
    guard let body = message.body as? String else {
      BareHostLogger.log("bareHost message is not a string")
      return
    }
    guard let bytes = Data(base64Encoded: body) else {
      BareHostLogger.log("bareHost message is not valid base64")
      return
    }
    onFrame(bytes)
  }

  private func onFrame(_ bytes: Data) {
    if bytes.isEmpty { return }

    if bytes.count > BareProtocol.maxFrameBytes {
      let parsed = BareProtocol.parseMessage(bytes)
      let error = BareProtocol.buildErrorResponse(
        headerJson: parsed?.header ?? "{}",
        code: ErrorCodes.frameTooLarge,
        message: "Frame exceeds maximum size"
      )
      if let frame = try? BareProtocol.buildMessage(
        type: error.type,
        headerJson: error.header,
        payload: error.payload
      ) {
        push(frame)
      }
      return
    }

    forwardToIpc(bytes)
  }
}
