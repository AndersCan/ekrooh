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

  public typealias Handler = ([String: Any]?, Data?) -> HostInvokeOutcome

  private var handlers: [Key: Handler] = [:]

  public init() {}

  public func register(
    pluginId: String,
    event: String,
    handler: @escaping Handler
  ) {
    handlers[Key(pluginId: pluginId, event: event)] = handler
  }

  /** Capability rows for `HOST_CAPABILITIES_RESPONSE`, runtimes `["ios"]`. */
  public func toCapabilitiesJSON() -> [[String: Any]] {
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
    payload: Data?
  ) -> HostInvokeOutcome {
    guard let handler = handlers[Key(pluginId: pluginId, event: event)] else {
      return .fail(
        code: ErrorCodes.unsupportedCapability,
        message: "No host handler for \(pluginId).\(event)"
      )
    }
    return handler(args, payload)
  }
}
