import BareKitBridge
import Foundation

public struct IPC: AsyncSequence {
  private let core: IPCCore

  /// Throws instead of force-unwrapping so callers can degrade gracefully when
  /// the IPC channel cannot be created for a valid worklet.
  public init(worklet: Worklet) throws {
    self.core = try IPCCore(worklet: worklet)
  }

  public func read() async throws -> Data? {
    return try await core.read()
  }

  public func write(data: Data) async throws {
    return try await core.write(data: data)
  }

  public func close() async {
    await core.close()
  }

  public typealias Element = Data

  public struct AsyncIterator: AsyncIteratorProtocol {
    fileprivate let core: IPCCore

    public func next() async throws -> Data? {
      return try await core.read()
    }
  }

  public func makeAsyncIterator() -> AsyncIterator {
    return AsyncIterator(core: core)
  }
}

/// Guards the underlying `BareIPC` with a `closed` flag so calls made after
/// `close()` fail with `IPCError.closed` instead of touching a torn-down
/// channel. Actors are reentrant: while a `read()` or `write()` is suspended
/// inside `BareIPC`, other calls (including `close()`) can run on this actor.
/// So this does NOT serialize I/O. `HostIpcCoordinator` has a single reader
/// and a single writer task, and the host awaits `close()` before terminating
/// the worklet (see the reference app's `BareRuntime.terminate()`).
private actor IPCCore {
  private let bareIPC: BareIPC
  private var closed = false

  init(worklet: Worklet) throws {
    guard let ipc = BareIPC(worklet: worklet.worklet) else {
      throw IPCError.initializationFailed
    }
    self.bareIPC = ipc
  }

  func read() async throws -> Data? {
    guard !closed else { throw IPCError.closed }
    return try await bareIPC.read()
  }

  func write(data: Data) async throws {
    guard !closed else { throw IPCError.closed }
    try await bareIPC.write(data)
  }

  func close() {
    guard !closed else { return }
    closed = true
    bareIPC.close()
  }
}

private enum IPCError: Error {
  case initializationFailed
  case closed
}
