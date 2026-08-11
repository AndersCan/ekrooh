import XCTest
import BareHost

final class HostPluginRegistryTest: XCTestCase {
  private func dispatchSync(
    _ registry: HostPluginRegistry,
    pluginId: String,
    event: String,
    args: [String: Any]? = nil
  ) -> HostPluginRegistry.HostInvokeOutcome {
    let expectation = expectation(description: "dispatch responded")
    var captured: HostPluginRegistry.HostInvokeOutcome?
    registry.dispatch(
      pluginId: pluginId,
      event: event,
      args: args,
      payload: nil
    ) { outcome in
      captured = outcome
      expectation.fulfill()
    }
    wait(for: [expectation], timeout: 5)
    return captured ?? .fail(code: "TEST", message: "no outcome")
  }

  func testDispatchesToARegisteredHandler() {
    let registry = HostPluginRegistry()
    registry.register(
      pluginId: "core.permissions",
      event: "permissions.requestStorage"
    ) { _, _, respond in
      respond(.ok(["granted": true]))
    }

    let outcome = dispatchSync(
      registry,
      pluginId: "core.permissions",
      event: "permissions.requestStorage",
      args: [:]
    )

    guard case .ok(let value) = outcome else {
      return XCTFail("expected Ok outcome")
    }
    XCTAssertEqual(true, value["granted"] as? Bool)
  }

  func testReturnsUnsupportedCapabilityForUnregisteredEvents() {
    let registry = HostPluginRegistry()

    let outcome = dispatchSync(
      registry,
      pluginId: "core.health",
      event: "health.ping"
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
    ) { _, _, respond in
      respond(.ok(["granted": true]))
    }
    registry.register(
      pluginId: "core.permissions",
      event: "permissions.requestOther"
    ) { _, _, respond in
      respond(.ok(["granted": true]))
    }
    registry.register(
      pluginId: "core.health",
      event: "health.ping"
    ) { _, _, respond in
      respond(.ok(["granted": true]))
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
