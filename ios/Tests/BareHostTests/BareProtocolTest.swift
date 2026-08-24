import XCTest
import BareHost

final class BareProtocolTest: XCTestCase {
  private let header =
    #"{"type":"DISPATCH","pluginId":"core.health","event":"health.ping"}"#

  func testRoundTripsTypeHeaderAndPayload() throws {
    let payload = Data([1, 2, 3])
    let buffer = try BareProtocol.buildMessage(
      type: BareProtocol.MessageType.envelope,
      headerJson: header,
      payload: payload
    )

    let message = BareProtocol.parseMessage(buffer)
    XCTAssertNotNil(message)
    XCTAssertEqual(BareProtocol.MessageType.envelope, message?.type)
    XCTAssertEqual(header, message?.header)
    XCTAssertEqual(payload, message?.payload)
  }

  func testParsesNilPayloadAsNil() throws {
    let buffer = try BareProtocol.buildMessage(
      type: BareProtocol.MessageType.envelope,
      headerJson: header,
      payload: nil
    )
    let message = BareProtocol.parseMessage(buffer)
    XCTAssertNotNil(message)
    XCTAssertNil(message?.payload)
  }

  func testRejectsAnUnsupportedVersion() throws {
    var buffer = try BareProtocol.buildMessage(
      type: BareProtocol.MessageType.envelope,
      headerJson: header,
      payload: nil
    )
    buffer[0] = 99
    XCTAssertNil(BareProtocol.parseMessage(buffer))
  }

  func testRejectsAnUnsupportedMessageType() throws {
    var buffer = try BareProtocol.buildMessage(
      type: BareProtocol.MessageType.envelope,
      headerJson: header,
      payload: nil
    )
    buffer[1] = 250
    XCTAssertNil(BareProtocol.parseMessage(buffer))
  }

  func testReturnsNilForATruncatedBuffer() throws {
    let full = try BareProtocol.buildMessage(
      type: BareProtocol.MessageType.envelope,
      headerJson: header,
      payload: nil
    )
    XCTAssertNil(BareProtocol.parseMessage(full.dropLast(1)))
  }

  func testRejectsASubSevenByteFrame() {
    // The envelope is [version][type][headerLen:2][payloadLen:3] = 7 bytes at
    // minimum. Shorter buffers must be rejected, not trapped by an out-of-bounds
    // read of bytes[4..6] when deriving payloadLen.
    XCTAssertNil(BareProtocol.parseMessage(Data([1, 2, 3, 4])))
    XCTAssertNil(BareProtocol.parseMessage(Data([1, 2, 3, 4, 5])))
    XCTAssertNil(BareProtocol.parseMessage(Data([1, 2, 3, 4, 5, 6])))
  }

  func testRejectsHeaderLargerThanThe16BitLengthField() {
    let bigHeader =
      #"{"type":"DISPATCH","pluginId":"core.health","event":"e","args":{"x":"# +
      String(repeating: "y", count: 0x10000) +
      #""}}"#
    XCTAssertThrowsError(
      try BareProtocol.buildMessage(
        type: BareProtocol.MessageType.envelope,
        headerJson: bigHeader,
        payload: nil
      )
    )
  }

  func testRejectsAFrameLargerThanTheMaximum() {
    let payload = Data(count: BareProtocol.maxFrameBytes)
    XCTAssertThrowsError(
      try BareProtocol.buildMessage(
        type: BareProtocol.MessageType.envelope,
        headerJson: header,
        payload: payload
      )
    )
  }

  func testReturnsNilForAnOversizedFrameOnParse() {
    var buffer = Data()
    buffer.append(BareProtocol.version)
    buffer.append(BareProtocol.MessageType.envelope)
    buffer.append(0)
    buffer.append(0)
    buffer.append(Data(count: BareProtocol.maxFrameBytes + 1))
    XCTAssertNil(BareProtocol.parseMessage(buffer))
  }

  func testBuildsAnInvokeResponseErrorEnvelopeFromARequestHeader() throws {
    let requestHeader =
      #"{"type":"INVOKE_REQUEST","pluginId":"core.health","event":"health.ping","requestId":"req-1"}"#
    let error = BareProtocol.buildErrorResponse(
      headerJson: requestHeader,
      code: ErrorCodes.frameTooLarge,
      message: "too big"
    )
    XCTAssertEqual(BareProtocol.MessageType.envelope, error.type)
    XCTAssertTrue(error.header.contains("\"requestId\":\"req-1\""))
    XCTAssertTrue(error.header.contains("\"code\":\"FRAME_TOO_LARGE\""))
    XCTAssertNil(error.payload)
  }
}
