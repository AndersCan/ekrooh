import { createInboundGate, type InboundGateOptions } from './backpressure';
import { ChannelHealth } from './channel-health';
import { ErrorCode, MessageType } from './constants';
import { encodeResponse } from './encode-response';
import { createFrameDecoder } from './framing';
import { toBytes } from './bytes';
import type { PluginRouter } from './plugin-kernel';
import type { MessageHeader, WireMessage } from './types';
import type { FrameContentError } from './frame-content';
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
   * and so must not queue behind the requests that wait on them. A host
   * response whose content could not be decoded is passed here as a
   * synthesized `HOST_INVOKE_RESPONSE` carrying `FRAME_INVALID`, so the call
   * waiting on it fails fast instead of timing out. */
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
  // Content errors are collected while a chunk drains and answered after the
  // frames decoded with them have been handled.
  let rejected: FrameContentError[] = [];
  // The decoder drains synchronously, so concurrent data events can never
  // interleave on its buffer; routing then runs concurrently.
  const decoder = createFrameDecoder(protocol, (err) => rejected.push(err));
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

  /** Writes one frame; a failing write is logged, never thrown into a promise
   * chain where it would become an unhandled rejection. */
  function safeWrite(frame: Uint8Array) {
    try {
      options.write(frame);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`${name} write failed: ${reason}`);
    }
  }

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

  /** Answers a frame whose content was rejected, when its routing fields
   * survived: a request gets a `FRAME_INVALID` response, and a host response
   * fails the call waiting on it. Nothing else is echoed back. */
  function answerRejected(err: FrameContentError) {
    console.error(
      `${name} invalid frame skipped: ${err.message.slice(0, 200)}`,
    );
    const recovered = err.recovered;
    const requestId = recovered?.requestId;
    if (!recovered || !requestId) return;
    const error = {
      code: ErrorCode.FRAME_INVALID,
      message: 'Frame could not be decoded',
    };
    if (
      recovered.type === 'HOST_INVOKE_RESPONSE' ||
      recovered.type === 'HOST_CAPABILITIES_RESPONSE'
    ) {
      // Only a channel that consumes host responses (the host IPC) acts on
      // these; elsewhere they are dropped like any stray host response.
      options.intercept?.({
        type: MessageType.ENVELOPE,
        header: {
          type: 'HOST_INVOKE_RESPONSE',
          requestId,
          pluginId: recovered.pluginId ?? '',
          event: recovered.event ?? '',
          error,
        },
        payload: new Uint8Array(0),
      });
      return;
    }
    if (recovered.type === 'INVOKE_REQUEST') {
      safeWrite(
        encodeResponse(protocol, {
          type: 'INVOKE_RESPONSE',
          pluginId: recovered.pluginId ?? '',
          event: recovered.event ?? '',
          requestId,
          error,
        }),
      );
    }
  }

  /** The answer to an invoke whose routing threw. The detail stays in the log;
   * the peer gets a fixed message. */
  function routingFailure(header: MessageHeader) {
    if (
      header.type === 'INVOKE_REQUEST' &&
      typeof header.requestId === 'string' &&
      typeof header.pluginId === 'string' &&
      typeof header.event === 'string'
    ) {
      safeWrite(
        encodeResponse(protocol, {
          type: 'INVOKE_RESPONSE',
          pluginId: header.pluginId,
          event: header.event,
          requestId: header.requestId,
          error: {
            code: ErrorCode.PLUGIN_ERROR,
            message: `${header.pluginId}.${header.event} failed`,
          },
        }),
      );
    }
  }

  function route(message: WireMessage) {
    const work = Promise.resolve()
      .then(() =>
        router.route(message.header, message.payload, { channel: name }),
      )
      .then(
        (response) => {
          if (response) safeWrite(encodeResponse(protocol, response));
        },
        (err) => {
          // A routing failure affects only this call; the stream stays usable.
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`${name} routing failed: ${reason}`);
          // An invoke still gets an answer, so its caller fails fast instead
          // of waiting out its timeout with nothing to explain why
          // (ekrooh#268).
          routingFailure(message.header);
        },
      )
      .catch((err) => {
        // Last resort: nothing in this chain may surface as an unhandled
        // rejection, which would take down a Bare worklet.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`${name} response failed: ${reason}`);
      });
    gate?.track(work);
  }

  function handle(messages: WireMessage[]) {
    for (const message of messages) {
      if (options.intercept?.(message)) continue;
      route(message);
    }
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
      rejected = [];
      const messages = decoder.push(bytes);
      const skipped = rejected;
      rejected = [];
      // The frames decoded before a framing violation in the same chunk were
      // whole and valid, so they are still handled; only the stream after the
      // violation is dropped.
      handle(messages);
      for (const err of skipped) answerRejected(err);
      if (decoder.error) {
        malformed(decoder.error.message);
        return;
      }
      health?.noteSuccess();
    },
    close() {
      stopped = true;
      decoder.clear();
    },
  };
}
