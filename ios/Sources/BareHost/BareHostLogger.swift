import BareKit
import Foundation
import os

public enum BareHostLogger {
  private static let logger = Logger(
    subsystem: "to.holepunch.bare.ios",
    category: "BareHost"
  )

  public static func log(_ message: String) {
    logger.error("\(message, privacy: .private)")
  }
}
