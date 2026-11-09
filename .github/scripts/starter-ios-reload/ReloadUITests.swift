import XCTest

/// With `npm run dev` running, the debug app shows the page from Vite: vote,
/// edit src/render.ts, and the page reloads with the vote kept.
final class ReloadUITests: XCTestCase {
  func testSavingRenderTsReloadsTheSimulator() throws {
    continueAfterFailure = false
    let path = try XCTUnwrap(ProcessInfo.processInfo.environment["VOTE_RENDER_TS"])
    let source = try String(contentsOfFile: path, encoding: .utf8)
    let before = "`${option.label} (${option.votes})`"
    XCTAssertTrue(source.contains(before), "render.ts has no button label to edit")

    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.buttons["Tea (0)"].waitForExistence(timeout: 90), app.debugDescription)
    app.buttons["Tea (0)"].tap()
    XCTAssertTrue(app.buttons["Tea (1)"].waitForExistence(timeout: 15), app.debugDescription)

    let after = source.replacingOccurrences(
      of: before, with: "`${option.label} [${option.votes}]`")
    try after.write(toFile: path, atomically: true, encoding: .utf8)
    XCTAssertTrue(app.buttons["Tea [1]"].waitForExistence(timeout: 20), app.debugDescription)
  }
}
