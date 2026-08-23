import BareKit
import XCTest

/// Ticket #24 / issue #41: proves the p2p native addons (rocksdb via
/// corestore, sodium via hyperdrive, udx via hyperswarm) actually run on the
/// iOS simulator, AND that a peer's drive can be opened by key, readied, and
/// read over a real hyperswarm connection (the #41 flow — the Android photo
/// app timed out on `drive.ready()`; the worklet now covers exactly that).
/// The worklet writes `p2p-verify.ok` (or `.fail`) into its storage dir, then
/// exits — the test boots it and polls for the marker.
final class P2PVerifyTest: XCTestCase {
  func testP2PStackRunsOnSimulator() throws {
    let storageDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("p2p-verify-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: storageDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: storageDir) }

    let worklet = try Worklet(
      configuration: Worklet.Configuration(
        memoryLimit: 128 << 20,
        assets: storageDir.appendingPathComponent("asset-cache").path
      )
    )
    worklet.start(
      name: "p2p-verify",
      ofType: "bundle",
      inBundle: .main,
      arguments: [storageDir.path]
    )

    let okMarker = storageDir.appendingPathComponent("p2p-verify.ok")
    let failMarker = storageDir.appendingPathComponent("p2p-verify.fail")
    // Headroom: the worklet now runs handshake + peer-drive replication (the
    // remote ready() may take a while on a cold CI simulator).
    let deadline = Date().addingTimeInterval(240)
    while Date() < deadline {
      if FileManager.default.fileExists(atPath: okMarker.path) {
        worklet.terminate()
        return
      }
      if FileManager.default.fileExists(atPath: failMarker.path) {
        let message = try? String(contentsOf: failMarker, encoding: .utf8)
        worklet.terminate()
        return XCTFail("p2p verify failed: \(message ?? "unknown")")
      }
      Thread.sleep(forTimeInterval: 0.5)
    }
    worklet.terminate()
    XCTFail("p2p verify did not complete within 240s")
  }
}
