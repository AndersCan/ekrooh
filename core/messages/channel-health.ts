/**
 * Per-channel decode/framing health tracker for the host↔worklet IPC pipe.
 *
 * The IPC pipe is a raw byte stream with no reconnect seam. A single corrupted
 * byte permanently desyncs the frame boundaries, so every subsequent frame
 * fails to decode. Unconditionally clearing the decoder after each failure
 * keeps parsing garbage forever — the channel is silently dead for the rest of
 * the session, and all host-delegated invokes time out until a restart.
 *
 * Instead we count consecutive decode/framing failures and treat a sustained run
 * as a fatal, unrecoverable desync. The caller then stops parsing rather than
 * spinning on garbage. A single isolated bad chunk is tolerated (the counter
 * resets on any successful frame batch), so transient corruption does not kill a
 * healthy channel.
 */
export class ChannelHealth {
  private consecutiveFailures = 0;
  private fatal = false;

  constructor(
    /** Consecutive decode/framing failures that prove an unrecoverable desync. */
    public readonly maxConsecutiveFailures = 5,
  ) {}

  /** Record a successful frame batch; resets the consecutive-failure counter. */
  noteSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Record a decode/framing failure. Returns `true` once the run of
   * consecutive failures reaches {@link maxConsecutiveFailures}, signalling the
   * caller that the channel is fatally desynced and parsing should stop.
   */
  noteFailure(): boolean {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.fatal = true;
      return true;
    }
    return false;
  }

  /** Whether a fatal, unrecoverable desync has been reached. */
  get isFatal(): boolean {
    return this.fatal;
  }

  /** Number of consecutive failures since the last successful frame batch. */
  get failures(): number {
    return this.consecutiveFailures;
  }
}
