import XCTest
import BareHost

final class HostPluginRegistryTest: XCTestCase {
  func testDispatchesToARegisteredHandler() {
    let registry = HostPluginRegistry()
    registry.register(
      pluginId: "core.permissions",
      event: "permissions.requestStorage"
    ) { _, _ in
      .ok(["granted": true])
    }

    let outcome = registry.dispatch(
      pluginId: "core.permissions",
      event: "permissions.requestStorage",
      args: [:],
      payload: nil
    )

    guard case .ok(let value) = outcome else {
      return XCTFail("expected Ok outcome")
    }
    XCTAssertEqual(true, value["granted"] as? Bool)
  }

  func testReturnsUnsupportedCapabilityForUnregisteredEvents() {
    let registry = HostPluginRegistry()

    let outcome = registry.dispatch(
      pluginId: "core.health",
      event: "health.ping",
      args: nil,
      payload: nil
    )

    guard case .fail(let code, let message) = outcome else {
      return XCTFail("expected Fail outcome")
    }
    XCTAssertEqual("UNSUPPORTED_CAPABILITY", code)
    XCTAssertTrue(message.contains("core.health.health.ping"))
  }

  func testGroupsCapabilityRowsByPluginAndSortsEvents() throws {
    let registry = HostPluginRegistry()
    registry.register(
      pluginId: "core.permissions",
      event: "permissions.requestStorage"
    ) { _, _ in
      .ok(["granted": true])
    }
    registry.register(
      pluginId: "core.permissions",
      event: "permissions.requestOther"
    ) { _, _ in
      .ok(["granted": true])
    }
    registry.register(
      pluginId: "core.health",
      event: "health.ping"
    ) { _, _ in
      .ok(["granted": true])
    }

    let rows = registry.toCapabilitiesJSON()
    XCTAssertEqual(2, rows.count)

    func row(_ pluginId: String) throws -> [String: Any] {
      for candidate in rows where candidate["pluginId"] as? String == pluginId {
        return candidate
      }
      throw NSError(domain: "test", code: 0)
    }

    let permissions = try row("core.permissions")
    let runtimes = try XCTUnwrap(permissions["runtimes"] as? [String])
    XCTAssertEqual(["ios"], runtimes)
    let events = try XCTUnwrap(permissions["events"] as? [String])
    XCTAssertEqual(
      ["permissions.requestOther", "permissions.requestStorage"],
      events
    )

    let health = try row("core.health")
    XCTAssertEqual(["health.ping"], health["events"] as? [String])
  }
}
