import XCTest

final class ReloadUITests: XCTestCase {
  private func renderTs() throws -> (path: String, source: String) {
    let path = try XCTUnwrap(ProcessInfo.processInfo.environment["VOTE_RENDER_TS"])
    return (path, try String(contentsOfFile: path, encoding: .utf8))
  }

  /// Backgrounding before the worklet starts must not crash the app. It casts
  /// no vote, so the next test still starts from Tea (0).
  func testBackgroundingDuringLaunchKeepsTheAppAlive() throws {
    let app = XCUIApplication()
    app.launch()
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(app.buttons["Tea (0)"].waitForExistence(timeout: 90), app.debugDescription)
  }

  /// With `npm run dev` running, the debug app shows the page from Vite. Edit
  /// src/render.ts before launch: only Vite can show the edited label. Vote,
  /// edit it back, and the page reloads with the vote kept.
  func testSavingRenderTsReloadsTheSimulator() throws {
    continueAfterFailure = false
    let (path, original) = try renderTs()
    let before = "`${option.label} (${option.votes})`"
    let edited = "`${option.label} [${option.votes}]`"
    XCTAssertTrue(original.contains(before), "render.ts has no button label to edit")
    addTeardownBlock { try? original.write(toFile: path, atomically: true, encoding: .utf8) }

    try original.replacingOccurrences(of: before, with: edited)
      .write(toFile: path, atomically: true, encoding: .utf8)
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.buttons["Tea [0]"].waitForExistence(timeout: 90), app.debugDescription)
    app.buttons["Tea [0]"].tap()
    XCTAssertTrue(app.buttons["Tea [1]"].waitForExistence(timeout: 15), app.debugDescription)

    try original.write(toFile: path, atomically: true, encoding: .utf8)
    XCTAssertTrue(app.buttons["Tea (1)"].waitForExistence(timeout: 20), app.debugDescription)
  }
}
