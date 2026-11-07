import BareKit
import Foundation

/**
 * Handles host-side IPC: capability queries and host invokes. The web layer
 * talks to the worklet over the loopback WebSocket socket, so nothing is
 * relayed to a WKWebView here. Mirror of
 * `android/.../HostIpcCoordinator.kt`.
 *
 * Frame handling lives in `HostIpcRouter` (transport-free, unit-tested); this
 * class only reads chunks off the `IPC` channel and writes the router's
 * response frames back, one at a time and in order.
 */
public final class HostIpcCoordinator {
  private let ipc: IPC
  private let router: HostIpcRouter
  private let outbound: AsyncStream<Data>
  private let outboundContinuation: AsyncStream<Data>.Continuation

  public init(
    ipc: IPC,
    hostPlugins: HostPluginRegistry
  ) {
    self.ipc = ipc
    var continuation: AsyncStream<Data>.Continuation!
    self.outbound = AsyncStream<Data> { continuation = $0 }
    self.outboundContinuation = continuation
    self.router = HostIpcRouter(hostPlugins: hostPlugins) { [continuation] frame in
      continuation?.yield(frame)
    }
  }

  deinit {
    outboundContinuation.finish()
  }

  public func start() {
    // Single writer: responses can be produced on any thread (a picker
    // callback, the invoke deadline), but frames reach `IPC.write` one at a
    // time, so two frames' bytes can never interleave on the channel.
    let ipc = self.ipc
    let outbound = self.outbound
    Task {
      for await frame in outbound {
        do {
          try await ipc.write(data: frame)
        } catch {
          BareHostLogger.log("IPC write failed")
        }
      }
    }

    let router = self.router
    Task {
      do {
        var decoder = FrameDecoder()
        for try await chunk in ipc {
          let messages = decoder.push(chunk)
          // A framing violation marks the decoder inert but still returns the
          // frames decoded before it; drop the corrupt byte stream and resync.
          if decoder.error != nil {
            BareHostLogger.log("IPC frame decoder desynced; resetting")
            decoder.clear()
          }
          for message in messages {
            router.handle(message)
          }
        }
      } catch {
        BareHostLogger.log("IPC stream ended")
      }
    }
  }
}

/**
 * The transport-free half of `HostIpcCoordinator`: turns one decoded frame
 * from the worklet into response frames, handed to `send` (from any thread).
 *
 * - `requestId`, `pluginId` and `event` must be non-empty strings of at most
 *   `maxFieldBytes` UTF-8 bytes (the Kotlin host's cap); anything else is
 *   answered with `FRAME_INVALID` instead of reaching a handler.
 * - Every invoke is answered exactly once: the handler's result, its failure,
 *   or `TIMEOUT` when the handler's deadline (`HostPluginRegistry.invokeTimeout`)
 *   passes first.
 * - A handler result that is not JSON-encodable, or a response over the frame
 *   limits, is answered with an error instead of crashing or being dropped.
 */
public final class HostIpcRouter {
  /// Cap on `requestId`, `pluginId` and `event`, in UTF-8 bytes. Mirror of
  /// `MAX_FIELD_BYTES` in the Kotlin `HostIpcCoordinator`.
  public static let maxFieldBytes = 256

  static func isValidField(_ value: String) -> Bool {
    let count = value.utf8.count
    return count >= 1 && count <= maxFieldBytes
  }

  private let hostPlugins: HostPluginRegistry
  private let send: (Data) -> Void

  public init(hostPlugins: HostPluginRegistry, send: @escaping (Data) -> Void) {
    self.hostPlugins = hostPlugins
    self.send = send
  }

  public func handle(_ message: BareProtocol.WireMessage) {
    guard
      let object = try? JSONSerialization.jsonObject(with: Data(message.header.utf8)),
      let header = object as? [String: Any]
    else {
      // No readable request to correlate with; answer anyway so the failure
      // is visible on the worklet side rather than a silent drop.
      sendError(requestHeader: "{}", code: ErrorCodes.frameInvalid, message: "Invalid envelope header")
      return
    }

    switch header["type"] as? String ?? "" {
    case "HOST_CAPABILITIES_QUERY":
      guard let reqId = header["requestId"] as? String, Self.isValidField(reqId) else {
        sendError(
          requestHeader: "{}", code: ErrorCodes.frameInvalid, message: "Missing or invalid requestId")
        return
      }
      sendHeader([
        "type": "HOST_CAPABILITIES_RESPONSE",
        "requestId": reqId,
        "capabilities": hostPlugins.toCapabilitiesJSON(),
      ])

    case "HOST_INVOKE_REQUEST":
      guard
        let reqId = header["requestId"] as? String, Self.isValidField(reqId),
        let pluginId = header["pluginId"] as? String, Self.isValidField(pluginId),
        let event = header["event"] as? String, Self.isValidField(event)
      else {
        sendError(
          requestHeader: message.header, code: ErrorCodes.frameInvalid,
          message: "Malformed HOST_INVOKE_REQUEST")
        return
      }
      invoke(
        reqId: reqId, pluginId: pluginId, event: event,
        args: header["args"] as? [String: Any], payload: message.payload)

    default:
      // Unknown header type: never silently drop the frame — answer with a
      // canonical error so the web side can surface a typed failure.
      sendError(
        requestHeader: message.header, code: ErrorCodes.frameInvalid,
        message: "Unknown IPC header type")
    }
  }

  private func invoke(
    reqId: String, pluginId: String, event: String, args: [String: Any]?, payload: Data?
  ) {
    let base: [String: Any] = [
      "type": "HOST_INVOKE_RESPONSE",
      "requestId": reqId,
      "pluginId": pluginId,
      "event": event,
    ]
    let responder = SingleResponse { [weak self] outcome in
      guard let self else { return }
      var header = base
      switch outcome {
      case .ok(let value):
        guard JSONSerialization.isValidJSONObject(value) else {
          header["error"] = [
            "code": ErrorCodes.invalidResponse,
            "message": "Host handler returned a value that is not JSON",
          ]
          self.sendHeader(header)
          return
        }
        header["result"] = value
      case .fail(let code, let message):
        header["error"] = ["code": code, "message": message]
      }
      self.sendHeader(header, fallback: base)
    }

    // Invoke deadline: emit a canonical timeout if the handler never responds.
    // The deadline is per handler (a picker waits on the user for minutes).
    let timeout = hostPlugins.invokeTimeout(pluginId: pluginId, event: event)
    // Clamped again here: the registry already bounds it, but a NaN or
    // out-of-range Double would trap in the UInt64 conversion.
    let bounded =
      timeout.isNaN ? HostPluginRegistry.defaultInvokeTimeout
      : Swift.min(Swift.max(0, timeout), HostPluginRegistry.maxInvokeTimeout)
    let nanoseconds = UInt64(bounded * 1_000_000_000)
    // The timer holds the responder strongly, so a handler that drops
    // `respond` without calling it is still answered at the deadline.
    responder.setTimer(
      Task {
        try? await Task.sleep(nanoseconds: nanoseconds)
        guard !Task.isCancelled else { return }
        responder.call(.fail(code: ErrorCodes.timeout, message: "Host invoke timed out"))
      })
    hostPlugins.dispatch(
      pluginId: pluginId,
      event: event,
      args: args,
      payload: payload,
      respond: responder.call
    )
  }

  /// Encodes and sends one response header. If it cannot be framed (over the
  /// header/frame limits), sends `fallback` with a `FRAME_TOO_LARGE` error so
  /// the caller is still answered.
  private func sendHeader(_ header: [String: Any], fallback: [String: Any]? = nil) {
    do {
      send(
        try BareProtocol.buildMessage(
          type: BareProtocol.MessageType.envelope,
          headerJson: BareProtocol.encodeJSON(header),
          payload: nil
        ))
    } catch {
      guard var fallback else { return }
      fallback["error"] = [
        "code": ErrorCodes.frameTooLarge,
        "message": "Host response exceeds the frame limits",
      ]
      sendHeader(fallback)
    }
  }

  private func sendError(requestHeader: String, code: String, message: String) {
    let error = BareProtocol.buildErrorResponse(
      headerJson: requestHeader, code: code, message: message, type: "HOST_INVOKE_RESPONSE")
    if let frame = try? BareProtocol.buildMessage(
      type: error.type, headerJson: error.header, payload: error.payload)
    {
      send(frame)
    }
  }

  /// Wraps a response callback so it runs at most once (success, failure, or
  /// invoke timeout all race to call it; only the first wins). The first call
  /// cancels the deadline timer so a finished invoke holds no sleeping Task.
  private final class SingleResponse {
    private let lock = NSLock()
    private var done = false
    private let send: (HostPluginRegistry.HostInvokeOutcome) -> Void
    private var timer: Task<Void, Never>?

    func setTimer(_ task: Task<Void, Never>) {
      lock.lock()
      let alreadyDone = done
      if !alreadyDone { timer = task }
      lock.unlock()
      if alreadyDone { task.cancel() }
    }

    init(_ send: @escaping (HostPluginRegistry.HostInvokeOutcome) -> Void) {
      self.send = send
    }

    func call(_ outcome: HostPluginRegistry.HostInvokeOutcome) {
      lock.lock()
      guard !done else {
        lock.unlock()
        return
      }
      done = true
      let pending = timer
      timer = nil
      lock.unlock()
      pending?.cancel()
      send(outcome)
    }
  }
}
