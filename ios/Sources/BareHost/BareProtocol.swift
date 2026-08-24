import Foundation

/// Errors thrown by `BareProtocol.buildMessage` on oversized frames.
public enum BareProtocolError: Error, Equatable {
  case headerTooLarge(Int)
  case frameTooLarge(Int)
}

/**
 * Mirror of `android/.../BareProtocol.kt`: the binary wire protocol codec.
 *
 * Envelope layout (identical bytes on every transport):
 *
 * ```
 * [version:1B][type:1B][headerLen:2B BE][payloadLen:3B BE]
 * [header: UTF-8 JSON][payload: raw bytes]
 * ```
 *
 * The binary payload length keeps frames self-delimiting even when a transport
 * re-serializes the JSON header (unknown header fields may be dropped, e.g. the
 * webview→worklet relay); the raw frame bytes — including this prefix — are
 * never altered. Header parsing keeps the JSON string untouched, so known
 * fields always pass through.
 */
public enum BareProtocol {
  /// Mirror of `VERSION` in `core/messages/constants.ts`.
  public static let version: UInt8 = 1

  /// Mirror of `MAX_HEADER_BYTES` in `core/messages/constants.ts`.
  public static let maxHeaderBytes = 0xffff

  /// Mirror of `MAX_FRAME_BYTES` in `core/messages/constants.ts`.
  public static let maxFrameBytes = 16 * 1024 * 1024

  public enum MessageType {
    public static let envelope: UInt8 = 1
  }

  public struct WireMessage {
    public let type: UInt8
    public let header: String
    public let payload: Data?
  }

  /**
   * Builds a frame. Throws `BareProtocolError` when the header or total frame
   * exceeds the protocol limits — never silently truncates (see the Kotlin
   * mirror).
   */
  public static func buildMessage(
    type: UInt8,
    headerJson: String,
    payload: Data? = nil
  ) throws -> Data {
    let headerBytes = Data(headerJson.utf8)
    if headerBytes.count > maxHeaderBytes {
      throw BareProtocolError.headerTooLarge(headerBytes.count)
    }
    let payloadBytes = payload ?? Data()

    // [version][type][headerLen(2 BE)][payloadLen(3 BE)][header][payload]: the
    // binary payload length keeps frames self-delimiting even when a transport
    // re-serializes the JSON header (mirrors core wire-codec).
    let totalLength = 7 + headerBytes.count + payloadBytes.count
    if totalLength > maxFrameBytes {
      throw BareProtocolError.frameTooLarge(totalLength)
    }

    var buffer = Data()
    buffer.reserveCapacity(totalLength)
    buffer.append(version)
    buffer.append(type)
    buffer.append(UInt8((headerBytes.count >> 8) & 0xff))
    buffer.append(UInt8(headerBytes.count & 0xff))
    buffer.append(UInt8((payloadBytes.count >> 16) & 0xff))
    buffer.append(UInt8((payloadBytes.count >> 8) & 0xff))
    buffer.append(UInt8(payloadBytes.count & 0xff))
    buffer.append(headerBytes)
    buffer.append(payloadBytes)
    return buffer
  }

  /**
   * Parses one frame. Returns `nil` for any invalid frame (too short,
   * oversized, unsupported version/type, truncated or oversized header),
   * mirroring the Kotlin `parseMessage` which returns null.
   */
  public static func parseMessage(_ buffer: Data) -> WireMessage? {
    let bytes = [UInt8](buffer)
    // Minimum envelope is [version][type][headerLen:2][payloadLen:3] = 7 bytes.
    // A shorter buffer must be rejected here, before the payloadLen read below
    // indexes bytes[4..6]; otherwise a 4–6 byte frame fatally traps.
    if bytes.count < 7 { return nil }
    if bytes.count > maxFrameBytes { return nil }

    let versionByte = bytes[0]
    if versionByte != version { return nil }

    let typeByte = bytes[1]
    if typeByte != MessageType.envelope { return nil }

    let headerLen = Int(bytes[2]) << 8 | Int(bytes[3])
    if headerLen > maxHeaderBytes { return nil }
    let payloadLen =
      (Int(bytes[4]) << 16) | (Int(bytes[5]) << 8) | Int(bytes[6])
    if bytes.count < 7 + headerLen + payloadLen { return nil }

    let headerBytes = bytes[7..<(7 + headerLen)]
    guard let headerJson = String(data: Data(headerBytes), encoding: .utf8) else {
      return nil
    }

    let payload: Data? =
      payloadLen > 0 && bytes.count >= 7 + headerLen + payloadLen
      ? Data(bytes[(7 + headerLen)..<(7 + headerLen + payloadLen)])
      : nil

    return WireMessage(type: typeByte, header: headerJson, payload: payload)
  }

  /**
   * Builds an `INVOKE_RESPONSE` envelope reporting an error for a frame the
   * bridge could not deliver, keyed to the original request when possible.
   */
  public static func buildErrorResponse(
    headerJson: String,
    code: String,
    message: String
  ) -> WireMessage {
    let request =
      (try? JSONSerialization.jsonObject(with: Data(headerJson.utf8)))
      as? [String: Any] ?? [:]
    var response: [String: Any] = [
      "type": "INVOKE_RESPONSE",
      "pluginId": request["pluginId"] as? String ?? "",
      "event": request["event"] as? String ?? "",
      "error": [
        "code": code,
        "message": message,
      ],
    ]
    if let requestId = request["requestId"] as? String {
      response["requestId"] = requestId
    }
    return WireMessage(
      type: MessageType.envelope,
      header: encodeJSON(response),
      payload: nil
    )
  }

  /** Compact JSON encoding; returns `{}` if the value cannot be encoded. */
  public static func encodeJSON(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(
      withJSONObject: value,
      options: [.withoutEscapingSlashes]
    ) else {
      return "{}"
    }
    return String(data: data, encoding: .utf8) ?? "{}"
  }
}
