import Foundation

/**
 * Canonical error codes, mirrored from `core/messages/constants.ts`.
 *
 * Keep this file in sync with the TypeScript `ErrorCode` union and
 * `android/.../ErrorCodes.kt`; the parity test enforces the contract.
 */
public enum ErrorCodes {
  public static let unsupportedCapability = "UNSUPPORTED_CAPABILITY"
  public static let unsupportedEvent = "UNSUPPORTED_EVENT"
  public static let hostError = "HOST_ERROR"
  public static let transportError = "TRANSPORT_ERROR"
  public static let pluginError = "PLUGIN_ERROR"
  public static let invalidResponse = "INVALID_RESPONSE"
  public static let frameTooLarge = "FRAME_TOO_LARGE"
  public static let frameInvalid = "FRAME_INVALID"
  public static let timeout = "TIMEOUT"
}
