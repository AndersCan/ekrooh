import Foundation

/**
 * Registers host-side invoke handlers for events delegated from the Bare
 * worklet over IPC. Mirror of `android/.../HostPluginRegistry.kt`.
 */
public final class HostPluginRegistry {
  public struct Key: Hashable {
    public let pluginId: String
    public let event: String

    public init(pluginId: String, event: String) {
      self.pluginId = pluginId
      self.event = event
    }
  }

  public enum HostInvokeOutcome {
    case ok([String: Any])
    case fail(code: String, message: String)
  }

  /// Handlers respond asynchronously ([respond] may be called later, e.g. after
  /// a native picker/camera result), mirroring the Kotlin registry.
  public typealias Handler =
    ([String: Any]?, Data?, @escaping (HostInvokeOutcome) -> Void) -> Void

  /// Deadline for a host invoke whose handler registered no timeout of its
  /// own. Mirrors `DEFAULT_HOST_INVOKE_TIMEOUT_MS` in `core/messages/host-ipc.ts`.
  public static let defaultInvokeTimeout: TimeInterval = 30

  /// Deadline for a handler that waits on the user (a picker, a camera, a
  /// system permission prompt), which can stay on screen for minutes. Matches
  /// `MEDIA_INVOKE_TIMEOUT_MS` in `plugins/media/events.ts`.
  public static let userMediatedInvokeTimeout: TimeInterval = 5 * 60

  /// `handlers` is mutated from `register` (main/UI thread) and read from
  /// `dispatch` (an IPC Task) — guard with an unfair lock to avoid a data race.
  private var handlers: [Key: Handler] = [:]
  private var timeouts: [Key: TimeInterval] = [:]
  private var lock = os_unfair_lock()

  public init() {}

  public func register(
    pluginId: String,
    event: String,
    handler: @escaping Handler
  ) {
    register(pluginId: pluginId, event: event, timeout: nil, handler: handler)
  }

  /// Registers a handler with its own invoke deadline. `timeout == nil` uses
  /// `defaultInvokeTimeout`; pass `userMediatedInvokeTimeout` for a handler that
  /// shows UI and waits for the user. When the deadline passes the caller gets
  /// a `TIMEOUT` error and a later `respond` is ignored.
  public func register(
    pluginId: String,
    event: String,
    timeout: TimeInterval?,
    handler: @escaping Handler
  ) {
    let key = Key(pluginId: pluginId, event: event)
    os_unfair_lock_lock(&lock)
    handlers[key] = handler
    timeouts[key] = timeout
    os_unfair_lock_unlock(&lock)
  }

  /// The invoke deadline for `pluginId`/`event`: the handler's own timeout, or
  /// `defaultInvokeTimeout` (also for events with no handler).
  public func invokeTimeout(pluginId: String, event: String) -> TimeInterval {
    os_unfair_lock_lock(&lock)
    defer { os_unfair_lock_unlock(&lock) }
    return timeouts[Key(pluginId: pluginId, event: event)] ?? Self.defaultInvokeTimeout
  }

  /** Capability rows for `HOST_CAPABILITIES_RESPONSE`, runtimes `["ios"]`. */
  public func toCapabilitiesJSON() -> [[String: Any]] {
    os_unfair_lock_lock(&lock)
    defer { os_unfair_lock_unlock(&lock) }
    var byPlugin: [String: Set<String>] = [:]
    for key in handlers.keys {
      var events = byPlugin[key.pluginId] ?? []
      events.insert(key.event)
      byPlugin[key.pluginId] = events
    }
    return byPlugin.keys.sorted().map { pluginId in
      let events = (byPlugin[pluginId] ?? []).sorted()
      return [
        "pluginId": pluginId,
        "capabilities": [],
        "events": events,
        "runtimes": ["ios"],
      ]
    }
  }

  public func dispatch(
    pluginId: String,
    event: String,
    args: [String: Any]?,
    payload: Data?,
    respond: @escaping (HostInvokeOutcome) -> Void
  ) {
    os_unfair_lock_lock(&lock)
    let handler = handlers[Key(pluginId: pluginId, event: event)]
    os_unfair_lock_unlock(&lock)
    // Fixed string only — never reflect caller-controlled pluginId/event back
    // to page JS (would enable capability probing).
    guard let handler else {
      respond(
        .fail(
          code: ErrorCodes.unsupportedCapability,
          message: "No host handler for the requested capability"
        )
      )
      return
    }
    handler(args, payload, respond)
  }
}
