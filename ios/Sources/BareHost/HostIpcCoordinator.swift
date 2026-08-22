import BareKit
import Foundation

/**
 * Handles host-side IPC: capability queries and host invokes. The web layer
 * talks to the worklet over the loopback WebSocket socket, so nothing is
 * relayed to a WKWebView here. Mirror of
 * `android/.../HostIpcCoordinator.kt`.
 */
public final class HostIpcCoordinator {
  private let ipc: IPC
  private let hostPlugins: HostPluginRegistry

  public init(
    ipc: IPC,
    hostPlugins: HostPluginRegistry
  ) {
    self.ipc = ipc
    self.hostPlugins = hostPlugins
  }

  public func start() {
    Task {
      do {
        for try await chunk in ipc {
          do {
            try await handle(data: chunk)
          } catch {
            // Log, never silently swallow: one bad frame must not kill the loop.
            // No interpolated error value — keep the message static.
            BareHostLogger.log("Error handling IPC frame")
          }
        }
      } catch {
        BareHostLogger.log("IPC stream ended")
      }
    }
  }

  private func handle(data: Data) async throws {
    guard let message = BareProtocol.parseMessage(data) else { return }
    let header = try jsonObject(message.header)
    switch header["type"] as? String ?? "" {
    case "HOST_CAPABILITIES_QUERY":
      let reqId = header["requestId"] as? String ?? ""
      let response: [String: Any] = [
        "type": "HOST_CAPABILITIES_RESPONSE",
        "requestId": reqId,
        "capabilities": hostPlugins.toCapabilitiesJSON(),
      ]
      let frame = try BareProtocol.buildMessage(
        type: BareProtocol.MessageType.envelope,
        headerJson: BareProtocol.encodeJSON(response),
        payload: nil
      )
      try await ipc.write(data: frame)

    case "HOST_INVOKE_REQUEST":
      let reqId = header["requestId"] as? String ?? ""
      let pluginId = header["pluginId"] as? String ?? ""
      let event = header["event"] as? String ?? ""
      let args = header["args"] as? [String: Any]

      // `respond` must fire exactly once: the registry handler may respond
      // asynchronously (e.g. after a native picker), and a handler that never
      // calls back would otherwise strand the web-side promise forever.
      let responder = SingleResponse { [weak self] outcome in
        var responseHeader: [String: Any] = [
          "type": "HOST_INVOKE_RESPONSE",
          "requestId": reqId,
          "pluginId": pluginId,
          "event": event,
        ]
        switch outcome {
        case .ok(let value):
          responseHeader["result"] = value
        case .fail(let code, let message):
          responseHeader["error"] = [
            "code": code,
            "message": message,
          ]
        }
        let frame = try? BareProtocol.buildMessage(
          type: BareProtocol.MessageType.envelope,
          headerJson: BareProtocol.encodeJSON(responseHeader),
          payload: nil
        )
        if let frame {
          Task { [weak self] in
            try? await self?.ipc.write(data: frame)
          }
        }
      }
      // Invoke deadline: emit a canonical timeout if the handler never responds.
      Task {
        try? await Task.sleep(nanoseconds: 30_000_000_000)
        responder.call(.fail(code: ErrorCodes.timeout, message: "Host invoke timed out"))
      }
      hostPlugins.dispatch(
        pluginId: pluginId,
        event: event,
        args: args,
        payload: message.payload,
        respond: responder.call
      )

    default:
      // Unknown header type: never silently drop the frame — answer with a
      // canonical HOST_ERROR so the web side can surface a typed failure.
      let reqId = header["requestId"] as? String ?? ""
      var responseHeader: [String: Any] = [
        "type": "HOST_INVOKE_RESPONSE",
        "requestId": reqId,
      ]
      responseHeader["error"] = [
        "code": ErrorCodes.hostError,
        "message": "Unknown IPC header type",
      ]
      if let frame = try? BareProtocol.buildMessage(
        type: BareProtocol.MessageType.envelope,
        headerJson: BareProtocol.encodeJSON(responseHeader),
        payload: nil
      ) {
        try? await ipc.write(data: frame)
      }
    }
  }

  /// Wraps a response callback so it runs at most once (success, failure, or
  /// invoke timeout all race to call it; only the first wins).
  private final class SingleResponse {
    private let lock = NSLock()
    private var done = false
    private let send: (HostPluginRegistry.HostInvokeOutcome) -> Void

    init(_ send: @escaping (HostPluginRegistry.HostInvokeOutcome) -> Void) {
      self.send = send
    }

    func call(_ outcome: HostPluginRegistry.HostInvokeOutcome) {
      lock.lock()
      defer { lock.unlock() }
      guard !done else { return }
      done = true
      send(outcome)
    }
  }

  private func jsonObject(_ header: String) throws -> [String: Any] {
    let object =
      try JSONSerialization.jsonObject(with: Data(header.utf8))
    guard let dictionary = object as? [String: Any] else {
      throw HostIpcError.invalidHeader
    }
    return dictionary
  }

  private enum HostIpcError: Error {
    case invalidHeader
  }
}
