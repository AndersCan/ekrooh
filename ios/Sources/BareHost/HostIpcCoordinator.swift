import BareKit
import Foundation

/**
 * Handles host-side IPC: capability queries, host invoke, and forwarding every
 * other envelope to the web layer as the **original bytes** (no re-parse, no
 * re-serialization). Mirror of `android/.../HostIpcCoordinator.kt`.
 */
public final class HostIpcCoordinator {
  private let ipc: IPC
  private let hostPlugins: HostPluginRegistry
  private let relayToWebView: (Data) -> Void

  public init(
    ipc: IPC,
    hostPlugins: HostPluginRegistry,
    relayToWebView: @escaping (Data) -> Void
  ) {
    self.ipc = ipc
    self.hostPlugins = hostPlugins
    self.relayToWebView = relayToWebView
  }

  public func start() {
    Task {
      do {
        for try await chunk in ipc {
          do {
            try await handle(data: chunk)
          } catch {
            // Log, never silently swallow: one bad frame must not kill the loop.
            BareHostLogger.log("Error handling IPC frame: \(error)")
          }
        }
      } catch {
        BareHostLogger.log("IPC stream ended: \(error)")
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
      let outcome = hostPlugins.dispatch(
        pluginId: pluginId,
        event: event,
        args: args,
        payload: message.payload
      )
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
      let frame = try BareProtocol.buildMessage(
        type: BareProtocol.MessageType.envelope,
        headerJson: BareProtocol.encodeJSON(responseHeader),
        payload: nil
      )
      try await ipc.write(data: frame)

    default:
      // Not a host envelope: relay the original bytes untouched.
      relayToWebView(data)
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
