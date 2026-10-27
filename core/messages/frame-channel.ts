import { createInboundGate, type InboundGateOptions } from './backpressure';
import { ChannelHealth } from './channel-health';
import { encodeResponse } from './encode-response';
import { createFrameDecoder } from './framing';
import { toBytes } from './bytes';
import type { PluginRouter } from './plugin-kernel';
import type { WireMessage } from './types';
import type { MessageProtocol } from './wire-codec';

/** What a malformed frame does to a channel.
 * - `close`: the peer can reconnect (the protocol socket), so the channel is
 *   torn down and the peer starts over on a clean stream.
 * - `tolerate`: there is no reconnect seam (the host IPC pipe), so the bad
 *   chunk is dropped and parsing resumes; a sustained run of failures proves
 *   the stream is desynced for good and parsing stops. */
export type MalformedFramePolicy =
  | { kind: 'close'; close(): void }
  | { kind: 'tolerate'; maxConsecutiveFailures?: number };

export interface FrameChannelOptions {
  /** Log prefix, e.g. `[ws]` or `[ipc]`. */
  name: string;
  protocol: MessageProtocol;
  router: Pick<PluginRouter, 'route'>;
  /** Sends one encoded frame to the peer. */
  write(frame: Uint8Array): void;
  onMalformed: MalformedFramePolicy;
  /** Consumes a decoded message before routing; returns true when it did. The
   * host IPC uses it for host responses, which resolve calls already waiting
   * and so must not queue behind the requests that wait on them. */
  intercept?(message: WireMessage): boolean;
  /** Pauses the inbound stream while too much routed work is pending. Not for
   * the host IPC: a pending host call waits on responses on that same stream. */
  inbound?: Omit<InboundGateOptions, 'high' | 'low'> & { maxPending: number };
}

/** One framed byte stream to a peer: reassembles frames from arbitrary chunks,
 * routes each request concurrently through the plugin router, and writes the
 * responses back. */
export interface FrameChannel {
  /** Feeds one inbound chunk. */
  push(chunk: unknown): void;
  /** Drops any partial frame (the stream is gone). */
  close(): void;
}

export function createFrameChannel(options: FrameChannelOptions): FrameChannel {
  const { name, protocol, router, onMalformed } = options;
  // The decoder drains synchronously, so concurrent data events can never
  // interleave on its buffer; routing then runs concurrently.
  const decoder = createFrameDecoder(protocol);
  const health =
    onMalformed.kind === 'tolerate'
      ? new ChannelHealth(onMalformed.maxConsecutiveFailures)
      : null;
  const gate = options.inbound
    ? createInboundGate({
        high: options.inbound.maxPending,
        low: Math.floor(options.inbound.maxPending / 2),
        pause: options.inbound.pause,
        resume: options.inbound.resume,
      })
    : null;
  let stopped = false;

  /** Handles a malformed chunk per the channel's policy. */
  function malformed(reason: string) {
    console.error(`${name} malformed frame dropped: ${reason}`);
    if (health === null) {
      stopped = true;
      decoder.clear();
      if (onMalformed.kind === 'close') onMalformed.close();
      return;
    }
    if (health.noteFailure()) {
      stopped = true;
      console.error(
        `${name} channel permanently desynced after repeated malformed frames; no longer parsing it`,
      );
    }
    decoder.clear();
  }

  function route(message: WireMessage) {
    const work = router
      .route(message.header, message.payload)
      .then((response) => {
        if (response) options.write(encodeResponse(protocol, response));
      })
      .catch((err) => {
        // A routing failure affects only this call; the stream stays usable.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`${name} routing failed: ${reason}`);
      });
    gate?.track(work);
  }

  return {
    push(chunk) {
      if (stopped) return;
      let bytes: Uint8Array;
      try {
        bytes = toBytes(chunk);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (health === null) {
          malformed(reason);
          return;
        }
        // A stray non-binary chunk on a stream with no reconnect seam carries
        // no bytes of a frame, so the partial frame already buffered stays.
        console.error(`${name} non-binary chunk dropped: ${reason}`);
        return;
      }
      if (bytes.byteLength === 0) return;
      const messages = decoder.push(bytes);
      // A frame-level failure marks the decoder inert but still returns the
      // frames decoded before it in the same chunk; those are dropped with it.
      if (decoder.error) {
        malformed(decoder.error.message);
        return;
      }
      health?.noteSuccess();
      for (const message of messages) {
        if (options.intercept?.(message)) continue;
        route(message);
      }
    },
    close() {
      stopped = true;
      decoder.clear();
    },
  };
}
