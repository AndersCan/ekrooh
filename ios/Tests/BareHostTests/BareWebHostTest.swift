import WebKit
import XCTest
import BareHost

/// Pins the iOS half of docs/security.md §5 that lives in `BareHost`:
/// navigation confinement, the origin-guarded main-frame bootstrap, the
/// handoff file being deleted when read, and storage excluded from backup.
final class BareWebHostTest: XCTestCase {
  private let handoffJSON = #"{"origin":"http://127.0.0.1:49233","port":49233,"bootstrap":"abc-_9XYZ"}"#

  // MARK: Handoff

  func testParsesALoopbackHandoff() throws {
    let handoff = try XCTUnwrap(BareHandoff.parse(Data(handoffJSON.utf8)))
    XCTAssertEqual("http://127.0.0.1:49233", handoff.origin)
    XCTAssertEqual(49233, handoff.port)
    XCTAssertEqual("abc-_9XYZ", handoff.bootstrap)
    XCTAssertEqual("http://127.0.0.1:49233/index.html", handoff.pageURL.absoluteString)
  }

  func testRejectsAnythingButALoopbackOriginAndABase64urlNonce() {
    for json in [
      #"{"origin":"http://evil.example:1","bootstrap":"a"}"#,
      #"{"origin":"http://localhost:1","bootstrap":"a"}"#,
      #"{"origin":"https://127.0.0.1:1","bootstrap":"a"}"#,
      #"{"origin":"http://127.0.0.1:","bootstrap":"a"}"#,
      #"{"origin":"http://127.0.0.1:0","bootstrap":"a"}"#,
      #"{"origin":"http://127.0.0.1:70000","bootstrap":"a"}"#,
      #"{"origin":"http://127.0.0.1:80/x","bootstrap":"a"}"#,
      #"{"origin":"http://127.0.0.1:80\"","bootstrap":"a"}"#,
      #"{"origin":"http://127.0.0.1:80","bootstrap":"a\"b"}"#,
      #"{"origin":"http://127.0.0.1:80","bootstrap":"</script>"}"#,
      #"{"origin":"http://127.0.0.1:80","bootstrap":""}"#,
      #"{"origin":"http://127.0.0.1:80"}"#,
      #"{"origin":"http://127.0.0.1:80","bootstrap":["a"]}"#,
      #"[]"#,
      #"{"#,
    ] {
      XCTAssertNil(BareHandoff.parse(Data(json.utf8)), json)
    }
  }

  func testConsumeDeletesTheHandoffAndLeavesAPartialOne() throws {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("handoff-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appendingPathComponent("handoff.json")

    XCTAssertNil(BareHandoff.consume(at: file))
    try Data(#"{"origin":"http://127.0"#.utf8).write(to: file)
    XCTAssertNil(BareHandoff.consume(at: file))
    XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "a partial write is retried")

    try Data(handoffJSON.utf8).write(to: file)
    XCTAssertNotNil(BareHandoff.consume(at: file))
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: file.path), "the nonce must not stay on disk")
  }

  func testTheBootstrapScriptIsOriginGuardedAndMainFrameOnly() throws {
    let handoff = try XCTUnwrap(BareHandoff.parse(Data(handoffJSON.utf8)))
    XCTAssertEqual(
      #"if (location.origin === "http://127.0.0.1:49233") { window.__ekrooh = {"bootstrap":"abc-_9XYZ"}; window.BareShell = true; }"#,
      handoff.bootstrapScriptSource)
    let script = handoff.bootstrapUserScript()
    XCTAssertTrue(script.isForMainFrameOnly)
    XCTAssertEqual(.atDocumentStart, script.injectionTime)
  }

  // MARK: Navigation policy

  private let policy = BareNavigationPolicy(allowedHost: "127.0.0.1", allowedPort: 8080)

  private func decide(
    _ url: String, policy: BareNavigationPolicy? = nil, main: Bool = true, newWindow: Bool = false,
    link: Bool = false
  ) -> BareNavigationDecision {
    (policy ?? self.policy).decide(
      url: URL(string: url), isMainFrame: main, isNewWindow: newWindow, isLinkActivated: link)
  }

  func testAllowsOnlyTheLoopbackOriginInTheMainFrame() {
    XCTAssertEqual(.allow, decide("http://127.0.0.1:8080/index.html"))
    XCTAssertEqual(.allow, decide("http://127.0.0.1:8080/media/x?y#z"))
    XCTAssertEqual(.allow, decide("about:blank"))
    // Look-alikes of the origin: never shown in the app view.
    for url in [
      "http://127.0.0.1:8081/", "http://localhost:8080/", "http://127.0.0.1.:8080/",
      "http://user@127.0.0.1:8080/", "https://127.0.0.1:8080/", "http://127.0.0.1/",
    ] {
      XCTAssertEqual(.cancel, decide(url), url)
      XCTAssertEqual(.openExternally, decide(url, link: true), url)
    }
    // Other schemes: never loaded, never handed to another app.
    for url in [
      "file:///etc/passwd", "data:text/html,x", "blob:http://127.0.0.1:8080/u",
      "about:blank#x", "about:srcdoc", "tel:123", "evil-scheme://x",
    ] {
      XCTAssertEqual(.cancel, decide(url), url)
      XCTAssertEqual(.cancel, decide(url, link: true), url)
    }
  }

  func testBeforeTheHandoffOnlyAStatusPageLoads() {
    let empty = BareNavigationPolicy()
    XCTAssertEqual(.allow, decide("about:blank", policy: empty))
    XCTAssertEqual(.cancel, decide("http://127.0.0.1:8080/", policy: empty))
  }

  func testOnlyAUserActivatedLinkOpensTheSystemBrowser() {
    XCTAssertEqual(.openExternally, decide("https://example.com/", link: true))
    XCTAssertEqual(.cancel, decide("https://example.com/"), "redirects and scripts never launch Safari")
    XCTAssertEqual(.openExternally, decide("https://example.com/", newWindow: true, link: true))
    XCTAssertEqual(.cancel, decide("https://example.com/", newWindow: true))
    XCTAssertEqual(.cancel, decide("http://127.0.0.1:8080/", newWindow: true, link: true))
  }

  func testSubframesStayOnTheOriginByDefault() {
    XCTAssertEqual(.allow, decide("http://127.0.0.1:8080/x", main: false))
    XCTAssertEqual(.allow, decide("about:srcdoc", main: false))
    XCTAssertEqual(.cancel, decide("https://example.com/", main: false, link: true))
    let relaxed = BareNavigationPolicy(
      allowedHost: "127.0.0.1", allowedPort: 8080, allowsForeignSubframes: true)
    XCTAssertEqual(.allow, decide("https://example.com/", policy: relaxed, main: false))
  }

  func testConfiningToAHandoffSetsTheOrigin() throws {
    let delegate = BareNavigationDelegate()
    delegate.confine(to: try XCTUnwrap(BareHandoff.parse(Data(handoffJSON.utf8))))
    XCTAssertEqual("127.0.0.1", delegate.policy.allowedHost)
    XCTAssertEqual(49233, delegate.policy.allowedPort)
  }

  func testConfigureDisablesLinkPreviews() {
    let webView = WKWebView(frame: .zero)
    BareWebHost.configure(webView)
    XCTAssertFalse(webView.allowsLinkPreview)
    if #available(iOS 16.4, *) {
      XCTAssertFalse(webView.isInspectable)
    }
  }

  // MARK: Storage

  func testStorageIsExcludedFromBackupAndMigratedFromDocuments() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("storage-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let legacy = root.appendingPathComponent("Documents/bare", isDirectory: true)
    try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
    try Data("corestore".utf8).write(to: legacy.appendingPathComponent("keep"))
    try Data(handoffJSON.utf8).write(to: legacy.appendingPathComponent("handoff.json"))

    let dirs = try BareStorage.prepare(
      applicationSupport: root.appendingPathComponent("Library/Application Support"),
      caches: root.appendingPathComponent("Library/Caches"),
      legacyStorage: legacy)

    XCTAssertTrue(dirs.storage.path.hasSuffix("Library/Application Support/bare"))
    XCTAssertTrue(dirs.cache.path.hasSuffix("Library/Caches/bare-cache"))
    XCTAssertEqual(
      "corestore",
      try String(contentsOf: dirs.storage.appendingPathComponent("keep"), encoding: .utf8))
    XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: dirs.handoff.path), "a stale handoff is removed")
    let values = try dirs.storage.resourceValues(forKeys: [.isExcludedFromBackupKey])
    XCTAssertEqual(true, values.isExcludedFromBackup)
  }
}
