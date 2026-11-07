import XCTest
import BareHost

/// Pins the host IPC contract that `HostIpcCoordinator` delegates to
/// `HostIpcRouter`: field caps (256 UTF-8 bytes, like Kotlin), every invoke
/// answered exactly once, per-handler deadlines, and no crash on a non-JSON
/// handler result.
final class HostIpcRouterTest: XCTestCase {
  /// Collects response headers the router sends.
  private final class Sink {
    private let lock = NSLock()
    private var headers: [[String: Any]] = []
    var onSend: (() -> Void)?

    func send(_ frame: Data) {
      guard let message = BareProtocol.parseMessage(frame),
        let header = try? JSONSerialization.jsonObject(with: Data(message.header.utf8))
          as? [String: Any]
      else { return XCTFail("router sent an unparseable frame") }
      lock.lock()
      headers.append(header)
      lock.unlock()
      onSend?()
    }

    var all: [[String: Any]] {
      lock.lock()
      defer { lock.unlock() }
      return headers
    }
  }

  private func message(_ headerJson: String) -> BareProtocol.WireMessage {
    let bytes = try! BareProtocol.buildMessage(
      type: BareProtocol.MessageType.envelope, headerJson: headerJson, payload: nil)
    return BareProtocol.parseMessage(bytes)!
  }

  private func frame(_ header: [String: Any]) -> BareProtocol.WireMessage {
    message(BareProtocol.encodeJSON(header))
  }

  private func invoke(_ requestId: String = "r1", pluginId: String = "test.plugin", event: String = "test.event")
    -> BareProtocol.WireMessage
  {
    frame([
      "type": "HOST_INVOKE_REQUEST", "requestId": requestId, "pluginId": pluginId, "event": event,
    ])
  }

  /// Handles `message` and waits for `count` responses.
  private func responses(
    _ registry: HostPluginRegistry, _ message: BareProtocol.WireMessage, count: Int = 1,
    timeout: TimeInterval = 5
  ) -> [[String: Any]] {
    let sink = Sink()
    let done = expectation(description: "responses")
    done.expectedFulfillmentCount = count
    sink.onSend = { done.fulfill() }
    let router = HostIpcRouter(hostPlugins: registry, send: sink.send)
    router.handle(message)
    wait(for: [done], timeout: timeout)
    return sink.all
  }

  private func errorCode(_ header: [String: Any]) -> String? {
    (header["error"] as? [String: Any])?["code"] as? String
  }

  func testAnswersAnInvokeWithTheHandlerResult() {
    let registry = HostPluginRegistry()
    registry.register(pluginId: "test.plugin", event: "test.event") { _, _, respond in
      respond(.ok(["value": 1]))
    }
    let header = responses(registry, invoke())[0]
    XCTAssertEqual("HOST_INVOKE_RESPONSE", header["type"] as? String)
    XCTAssertEqual("r1", header["requestId"] as? String)
    XCTAssertEqual(1, (header["result"] as? [String: Any])?["value"] as? Int)
  }

  func testRefusesFieldsOverTheCapOrMissing() {
    let registry = HostPluginRegistry()
    var called = false
    registry.register(pluginId: "test.plugin", event: "test.event") { _, _, respond in
      called = true
      respond(.ok([:]))
    }
    let long = String(repeating: "x", count: HostIpcRouter.maxFieldBytes + 1)
    // 129 two-byte characters: 258 UTF-8 bytes, under 256 UTF-16 units.
    let wide = String(repeating: "é", count: 129)
    for message in [
      invoke(long), invoke(pluginId: long), invoke(event: wide), invoke(""),
      frame(["type": "HOST_INVOKE_REQUEST", "requestId": 7, "pluginId": "test.plugin", "event": "test.event"]),
    ] {
      let header = responses(registry, message)[0]
      XCTAssertEqual(ErrorCodes.frameInvalid, errorCode(header))
      XCTAssertNotEqual(long, header["requestId"] as? String, "an oversized id is never echoed")
    }
    XCTAssertFalse(called, "a malformed request must not reach the handler")
    XCTAssertEqual(256, HostIpcRouter.maxFieldBytes)
  }

  func testAnswersAnUnreadableOrUnknownHeader() {
    let registry = HostPluginRegistry()
    let notObject = message("[1,2]")
    XCTAssertEqual(ErrorCodes.frameInvalid, errorCode(responses(registry, notObject)[0]))
    let notJSON = message("{")
    XCTAssertEqual(ErrorCodes.frameInvalid, errorCode(responses(registry, notJSON)[0]))
    let unknown = responses(registry, frame(["type": "NOPE", "requestId": "r9"]))[0]
    XCTAssertEqual(ErrorCodes.frameInvalid, errorCode(unknown))
    XCTAssertEqual("r9", unknown["requestId"] as? String)
  }

  func testCapabilitiesQueryNeedsAValidRequestId() {
    let registry = HostPluginRegistry()
    registerDefaultHostPlugins(registry)
    let ok = responses(registry, frame(["type": "HOST_CAPABILITIES_QUERY", "requestId": "q1"]))[0]
    XCTAssertEqual("HOST_CAPABILITIES_RESPONSE", ok["type"] as? String)
    XCTAssertEqual("q1", ok["requestId"] as? String)
    let bad = responses(registry, frame(["type": "HOST_CAPABILITIES_QUERY"]))[0]
    XCTAssertEqual(ErrorCodes.frameInvalid, errorCode(bad))
  }

  func testANonJSONResultIsAnErrorNotACrash() {
    let registry = HostPluginRegistry()
    registry.register(pluginId: "test.plugin", event: "test.event") { _, _, respond in
      respond(.ok(["url": URL(string: "https://example.com")!, "nan": Double.nan]))
    }
    let header = responses(registry, invoke())[0]
    XCTAssertEqual(ErrorCodes.invalidResponse, errorCode(header))
    XCTAssertEqual("r1", header["requestId"] as? String)
    XCTAssertEqual("{}", BareProtocol.encodeJSON(["date": Date()]))
  }

  func testAResultOverTheFrameLimitsIsAnswered() {
    let registry = HostPluginRegistry()
    registry.register(pluginId: "test.plugin", event: "test.event") { _, _, respond in
      respond(.ok(["blob": String(repeating: "a", count: BareProtocol.maxHeaderBytes + 1)]))
    }
    XCTAssertEqual(ErrorCodes.frameTooLarge, errorCode(responses(registry, invoke())[0]))
  }

  func testTheHandlersOwnDeadlineAnswersATimeoutOnce() {
    let registry = HostPluginRegistry()
    var late: ((HostPluginRegistry.HostInvokeOutcome) -> Void)?
    // A handler that holds `respond` past its deadline, then answers late.
    registry.register(pluginId: "test.plugin", event: "test.event", timeout: 0.05) { _, _, respond in
      late = respond
    }
    let sink = Sink()
    let first = expectation(description: "timeout")
    sink.onSend = { first.fulfill() }
    let router = HostIpcRouter(hostPlugins: registry, send: sink.send)
    router.handle(invoke())
    wait(for: [first], timeout: 5)
    late?(.ok(["too": "late"]))
    XCTAssertEqual(1, sink.all.count, "an invoke is answered exactly once")
    XCTAssertEqual(ErrorCodes.timeout, errorCode(sink.all[0]))
  }

  func testAHandlerThatDropsRespondStillTimesOut() {
    let registry = HostPluginRegistry()
    registry.register(pluginId: "test.plugin", event: "test.event", timeout: 0.05) { _, _, _ in }
    XCTAssertEqual(ErrorCodes.timeout, errorCode(responses(registry, invoke())[0]))
  }

  func testDeadlinesArePerHandler() {
    let registry = HostPluginRegistry()
    registerDefaultHostPlugins(registry)
    registry.register(pluginId: "a", event: "b") { _, _, _ in }
    XCTAssertEqual(30, HostPluginRegistry.defaultInvokeTimeout)
    XCTAssertEqual(300, HostPluginRegistry.userMediatedInvokeTimeout)
    XCTAssertEqual(30, registry.invokeTimeout(pluginId: "a", event: "b"))
    XCTAssertEqual(30, registry.invokeTimeout(pluginId: "no", event: "handler"))
    XCTAssertEqual(
      300, registry.invokeTimeout(pluginId: "core.permissions", event: "permissions.request"))
    XCTAssertEqual(
      30, registry.invokeTimeout(pluginId: "core.permissions", event: "permissions.status"))
  }

  func testErrorResponsesEchoOnlyValidFields() {
    let long = String(repeating: "x", count: 300)
    let header = BareProtocol.encodeJSON(["requestId": long, "pluginId": "p", "event": long])
    let error = BareProtocol.buildErrorResponse(
      headerJson: header, code: ErrorCodes.frameInvalid, message: "m", type: "HOST_INVOKE_RESPONSE")
    let decoded = try? JSONSerialization.jsonObject(with: Data(error.header.utf8)) as? [String: Any]
    XCTAssertEqual("HOST_INVOKE_RESPONSE", decoded?["type"] as? String)
    XCTAssertNil(decoded?["requestId"])
    XCTAssertEqual("p", decoded?["pluginId"] as? String)
    XCTAssertEqual("", decoded?["event"] as? String)
  }
}
