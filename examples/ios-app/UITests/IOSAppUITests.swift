import XCTest

/// End-to-end harness against the reference app: asserts the health-checks page
/// renders the merged discovery summary and that the worklet round-trips Ping /
/// Payload Echo / Roundtrip / Storage permission exactly like on Android.
final class IOSAppUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func testHealthChecksPageEndToEnd() throws {
    let app = XCUIApplication()
    app.launch()

    let discovery = app.staticTexts.matching(
      NSPredicate(
        format: "label CONTAINS %@",
        "Discovery v1: 5 plugin(s) — core.health, core.discovery, core.permissions, vendor.media, core.logs"
      )
    ).firstMatch
    XCTAssertTrue(
      discovery.waitForExistence(timeout: 30),
      "Discovery summary did not appear:\n\(app.debugDescription)"
    )

    XCTAssertTrue(app.buttons["Ping"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Payload Echo"].exists)
    XCTAssertTrue(app.buttons["Roundtrip"].exists)
    XCTAssertTrue(app.buttons["Storage permission"].exists)
    XCTAssertTrue(app.buttons["Pick image"].exists)
    XCTAssertTrue(app.buttons["Capture image"].exists)

    app.buttons["Ping"].tap()
    XCTAssertTrue(
      waitForResult(app, containing: "PING ok:"),
      "Ping did not complete"
    )

    app.buttons["Payload Echo"].tap()
    XCTAssertTrue(
      waitForResult(app, containing: "PAYLOAD ok:"),
      "Payload Echo did not complete"
    )

    app.buttons["Roundtrip"].tap()
    XCTAssertTrue(
      waitForResult(app, containing: "ROUNDTRIP ok:"),
      "Roundtrip did not complete"
    )

    app.buttons["Storage permission"].tap()
    XCTAssertTrue(
      waitForResult(app, containing: "Storage permission: storage=granted"),
      "Storage permission did not complete"
    )

    // Capture on the simulator is deterministic: no camera, so the handler
    // answers "camera unavailable" without presenting a picker. The real
    // picker/camera success paths are physical-device verification only (#6).
    app.buttons["Capture image"].tap()
    XCTAssertTrue(
      waitForResult(app, containing: "Media capture failed: camera unavailable"),
      "Camera-unavailable error did not appear"
    )
  }

  private func waitForResult(_ app: XCUIApplication, containing text: String)
    -> Bool
  {
    let predicate = NSPredicate(format: "label CONTAINS %@", text)
    let element = app.staticTexts.matching(predicate).firstMatch
    return element.waitForExistence(timeout: 20)
  }
}
