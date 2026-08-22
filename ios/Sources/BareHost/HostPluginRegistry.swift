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

  /// `handlers` is mutated from `register` (main/UI thread) and read from
  /// `dispatch` (an IPC Task) — guard with an unfair lock to avoid a data race.
  private var handlers: [Key: Handler] = [:]
  private var lock = os_unfair_lock()

  public init() {}

  public func register(
    pluginId: String,
    event: String,
    handler: @escaping Handler
  ) {
    os_unfair_lock_lock(&lock)
    handlers[Key(pluginId: pluginId, event: event)] = handler
    os_unfair_lock_unlock(&lock)
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
