import Foundation

/**
 * Registers the canonical host plugin handlers. Mirror of
 * `android/.../DefaultHostPlugins.kt`.
 */
public func registerDefaultHostPlugins(_ registry: HostPluginRegistry) {
  registry.register(
    pluginId: "core.permissions",
    event: "permissions.requestStorage"
  ) { _, _ in
    // Stub: integrate with a real permission prompt for production.
    .ok(["granted": true])
  }
}
