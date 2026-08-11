import XCTest
import BareHost

/**
 * Enforces that the Swift mirror of the TS `ErrorCode` union stays in sync
 * with `core/messages/constants.ts` and `android/.../ErrorCodes.kt`. Extend
 * when codes are added on either side.
 */
final class ErrorCodesParityTest: XCTestCase {
  func testErrorCodesMatchTheCanonicalWireCodes() {
    XCTAssertEqual("UNSUPPORTED_CAPABILITY", ErrorCodes.unsupportedCapability)
    XCTAssertEqual("UNSUPPORTED_EVENT", ErrorCodes.unsupportedEvent)
    XCTAssertEqual("HOST_ERROR", ErrorCodes.hostError)
    XCTAssertEqual("TRANSPORT_ERROR", ErrorCodes.transportError)
    XCTAssertEqual("PLUGIN_ERROR", ErrorCodes.pluginError)
    XCTAssertEqual("INVALID_RESPONSE", ErrorCodes.invalidResponse)
    XCTAssertEqual("FRAME_TOO_LARGE", ErrorCodes.frameTooLarge)
    XCTAssertEqual("FRAME_INVALID", ErrorCodes.frameInvalid)
    XCTAssertEqual("TIMEOUT", ErrorCodes.timeout)
  }

  func testFrameLimitsMatchTheTSConstants() {
    XCTAssertEqual(0xffff, BareProtocol.maxHeaderBytes)
    XCTAssertEqual(16 * 1024 * 1024, BareProtocol.maxFrameBytes)
  }
}
