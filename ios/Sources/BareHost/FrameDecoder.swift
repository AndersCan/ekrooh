import Foundation

/**
 * Receive-side frame reassembler for the host→worklet IPC byte stream.
 *
 * `BareKit`'s `IPC` does not preserve message boundaries, so a frame may
 * arrive split across chunks or with several frames coalesced into one. This
 * buffers partial bytes until the binary length prefix (`headerLen` + `payloadLen`)
 * proves a complete frame is available, then parses exactly `frameLen` bytes and
 * keeps the remainder for the next `push`. The reassembly mirrors
 * `core/messages/framing.ts`'s `createFrameDecoder` so an oversized or
 * header-truncated frame drops precisely the corrupt bytes (self-resync) and a
 * complete frame that fails to parse is skipped rather than desyncing the rest
 * of the stream.
 */
public struct FrameDecoder {
  private var buffer = Data()
  public private(set) var error: Error?

  public init() {}

  /**
   * Appends `chunk` and returns every frame that is now complete. Partial bytes
   * are retained for the next call. After a framing violation the decoder goes
   * inert (`error` set) and returns the frames decoded before it; `clear()`
   * resets it.
   */
  public mutating func push(_ chunk: Data) -> [BareProtocol.WireMessage] {
    if error != nil { return [] }
    buffer.append(chunk)

    var out: [BareProtocol.WireMessage] = []
    while buffer.count >= 7 {
      let bytes = [UInt8](buffer)
      let headerLen = Int(bytes[2]) << 8 | Int(bytes[3])
      if headerLen > BareProtocol.maxHeaderBytes {
        fail(BareProtocolError.headerTooLarge(headerLen))
        return out
      }
      let payloadLen =
        (Int(bytes[4]) << 16) | (Int(bytes[5]) << 8) | Int(bytes[6])
      let frameLen = 7 + headerLen + payloadLen
      if frameLen > BareProtocol.maxFrameBytes {
        fail(BareProtocolError.frameTooLarge(frameLen))
        return out
      }
      if buffer.count < frameLen { break }

      let frame = buffer.subdata(in: 0..<frameLen)
      buffer.removeSubrange(0..<frameLen)
      if let message = BareProtocol.parseMessage(frame) {
        out.append(message)
      }
    }

    // A partial longer than the frame cap can never complete a legal frame.
    if buffer.count > BareProtocol.maxFrameBytes {
      fail(BareProtocolError.frameTooLarge(buffer.count))
    }

    return out
  }

  public mutating func clear() {
    buffer = Data()
    error = nil
  }

  private mutating func fail(_ err: Error) {
    error = err
    // Drop everything buffered: a corrupt byte in the pending partial desyncs
    // the stream, so the only safe resync point is a fresh frame boundary.
    buffer = Data()
  }
}
