import XCTest
import BareHost

final class DefaultHostPluginsTest: XCTestCase {
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

  func testStorageIsGrantedForStatusAndRequest() {
    let registry = HostPluginRegistry()
    registerDefaultHostPlugins(registry)

    for event in ["permissions.status", "permissions.request"] {
      let outcome = dispatchSync(
        registry,
        pluginId: "core.permissions",
        event: event,
        args: ["permission": "storage"]
      )
      guard case .ok(let value) = outcome else {
        return XCTFail("expected Ok outcome for \(event)")
      }
      XCTAssertEqual("storage", value["permission"] as? String)
      XCTAssertEqual("granted", value["status"] as? String)
    }
  }

  func testCameraStatusMapsToARealSystemState() {
    let registry = HostPluginRegistry()
    registerDefaultHostPlugins(registry)

    let outcome = dispatchSync(
      registry,
      pluginId: "core.permissions",
      event: "permissions.status",
      args: ["permission": "camera"]
    )
    guard case .ok(let value) = outcome else {
      return XCTFail("expected Ok outcome")
    }
    XCTAssertEqual("camera", value["permission"] as? String)
    let status = try? XCTUnwrap(value["status"] as? String)
    XCTAssertTrue(
      ["granted", "denied", "notDetermined", "unsupported"].contains(status ?? ""),
      "unexpected camera status \(status ?? "nil")"
    )
  }

  func testCapabilitiesListRequestAndStatus() {
    let registry = HostPluginRegistry()
    registerDefaultHostPlugins(registry)

    let rows = registry.toCapabilitiesJSON()
    XCTAssertEqual(1, rows.count)
    let permissions = try? XCTUnwrap(rows.first)
    XCTAssertEqual("core.permissions", permissions?["pluginId"] as? String)
    XCTAssertEqual(
      ["permissions.request", "permissions.status"],
      permissions?["events"] as? [String]
    )
  }

  /// docs/security.md §4: permission ids are allowlisted. A missing,
  /// non-string, oversized or unknown id is `unsupported` — never `granted`
  /// (it used to fall back to `storage`).
  func testUnknownOrMalformedPermissionIdsFailClosed() {
    let registry = HostPluginRegistry()
    registerDefaultHostPlugins(registry)

    let cases: [[String: Any]?] = [
      nil,
      [:],
      ["permission": 42],
      ["permission": NSNull()],
      ["permission": "microphone"],
      ["permission": "Storage"],
      ["permission": String(repeating: "s", count: 300)],
    ]
    for event in ["permissions.status", "permissions.request"] {
      for args in cases {
        let outcome = dispatchSync(
          registry, pluginId: "core.permissions", event: event, args: args)
        guard case .ok(let value) = outcome else {
          return XCTFail("expected Ok outcome for \(event) \(String(describing: args))")
        }
        XCTAssertEqual(
          "unsupported", value["status"] as? String,
          "\(event) \(String(describing: args)) must fail closed")
        XCTAssertLessThanOrEqual((value["permission"] as? String)?.utf8.count ?? 0, 256)
      }
    }
  }
}
