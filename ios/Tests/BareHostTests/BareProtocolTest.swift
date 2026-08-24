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

final class FrameDecoderTest: XCTestCase {
  private let header =
    #"{"type":"DISPATCH","pluginId":"core.health","event":"health.ping"}"#

  private func frame(payload: Data? = nil) throws -> Data {
    try BareProtocol.buildMessage(
      type: BareProtocol.MessageType.envelope,
      headerJson: header,
      payload: payload
    )
  }

  func testReassemblesAFrameSplitAcrossChunks() throws {
    let f = try frame(payload: Data([1, 2, 3, 4]))
    var decoder = FrameDecoder()
    // Feed the frame one byte at a time; no complete frame until the last byte.
    var decoded: [BareProtocol.WireMessage] = []
    for i in 0..<f.count {
      decoded.append(contentsOf: decoder.push(f.subdata(in: i..<(i + 1))))
    }
    XCTAssertEqual(decoded.count, 1)
    XCTAssertEqual(decoded.first?.payload, Data([1, 2, 3, 4]))
  }

  func testDrainsCoalescedFramesInOrder() throws {
    let f1 = try frame()
    let f2 = try frame(payload: Data([9]))
    var both = Data()
    both.append(f1)
    both.append(f2)

    var decoder = FrameDecoder()
    let decoded = decoder.push(both)
    XCTAssertEqual(decoded.count, 2)
    XCTAssertEqual(decoded.last?.payload, Data([9]))
  }

  func testSkipsACorruptCompleteFrameWithoutDesyncingTheRest() throws {
    let f1 = try frame()
    // A complete but invalid frame (unsupported version) that the decoder must
    // drop, not let desync the stream.
    var bad = try frame()
    bad[0] = 99
    let f2 = try frame(payload: Data([7]))

    var both = Data()
    both.append(f1)
    both.append(bad)
    both.append(f2)

    var decoder = FrameDecoder()
    let decoded = decoder.push(both)
    // The corrupt frame is skipped; the two good frames still parse.
    XCTAssertEqual(decoded.count, 2)
    XCTAssertEqual(decoded.last?.payload, Data([7]))
  }

  func testGoesInertAfterAFrameTooLargeAndResyncsOnClear() throws {
    var decoder = FrameDecoder()
    // headerLen 0, payloadLen 0xffffff: frameLen exceeds the cap (a framing
    // violation).
    var oversized = Data()
    oversized.append(BareProtocol.version)
    oversized.append(BareProtocol.MessageType.envelope)
    oversized.append(0)
    oversized.append(0)
    oversized.append(0xff)
    oversized.append(0xff)
    oversized.append(0xff)
    let first = decoder.push(oversized)
    XCTAssertEqual(first.count, 0)
    XCTAssertNotNil(decoder.error)

    decoder.clear()
    let good = decoder.push(try frame())
    XCTAssertEqual(good.count, 1)
    XCTAssertNil(decoder.error)
  }
}
