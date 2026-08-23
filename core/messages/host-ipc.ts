import { MessageType } from './constants';
import { MessageProtocol } from './wire-codec';
import type {
  CapabilityDescriptor,
  HostCapabilitiesResponseHeader,
  HostInvokeResponseHeader,
  MessageHeader,
  PluginInvokeRequestHeader,
  PluginInvokeResponseHeader,
  WireMessage,
} from './types';

function toUint8Array(data: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data))
    return new Uint8Array(data);
  return new Uint8Array(data);
}

function newCorrelationId(): string {
  // CSPRNG-backed (not Math.random): unguessable request ids for host IPC.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const rand = bytes.reduce((acc, b) => acc + b.toString(36), '').slice(0, 22);
  return `${Date.now().toString(36)}-${rand}`;
}

type Pending = {
  resolve: (h: MessageHeader) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Hard ceiling on concurrently pending host calls. Above this, the oldest call
 * is dropped (its timer cleared and promise rejected) so a flood of invokes
 * cannot grow the pending map without bound. */
const MAX_CONCURRENT_HOST_CALLS = 1024;

/** Sane default for a host invoke: five-minute waits let a single stalled host
 * call pin a slot indefinitely, so we default to 30s instead. */
const DEFAULT_HOST_INVOKE_TIMEOUT_MS = 30000;

export type BareIpcLike = {
  write(data: Uint8Array | Buffer | string): boolean;
};

function writeEncoded(ipc: BareIpcLike, bytes: Uint8Array) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    ipc.write(Buffer.from(bytes));
  } else {
    ipc.write(bytes as unknown as Buffer);
  }
}

export function createHostIpcBridge(config: {
  ipc: BareIpcLike;
  protocol: MessageProtocol;
}) {
  const { ipc, protocol } = config;
  const pending = new Map<string, Pending>();

  function track(requestId: string, slot: Pending) {
    if (pending.size >= MAX_CONCURRENT_HOST_CALLS) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) {
        const dropped = pending.get(oldest);
        if (dropped) {
          clearTimeout(dropped.timer);
          dropped.reject(
            new Error(
              `host invoke dropped: too many concurrent host calls (${oldest})`,
            ),
          );
        }
        pending.delete(oldest);
      }
    }
    pending.set(requestId, slot);
  }

  function waitFor<T extends MessageHeader>(
    requestId: string,
    expectedType: T['type'],
    timeoutMs: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(
          new Error(
            `Host IPC timeout waiting for ${String(expectedType)} (${requestId})`,
          ),
        );
      }, timeoutMs);
      track(requestId, {
        timer,
        resolve: (h: MessageHeader) => {
          clearTimeout(timer);
          pending.delete(requestId);
          if (h.type === expectedType) {
            resolve(h as T);
            return;
          }
          reject(
            new Error(
              `Unexpected host response type ${h.type}, expected ${String(expectedType)}`,
            ),
          );
        },
        reject,
      });
    });
  }

  /** Classifies a pre-decoded downstream message: resolves the matching pending
   * host call when it is a `HOST_CAPABILITIES_RESPONSE` or `HOST_INVOKE_RESPONSE`
   * for a known `requestId`; otherwise returns false so the caller can route the
   * message through the plugin router (host responses never reach plugins). */
  function consumeDownstream(parsed: WireMessage): boolean {
    const h = parsed.header;
    if (
      h.type !== 'HOST_CAPABILITIES_RESPONSE' &&
      h.type !== 'HOST_INVOKE_RESPONSE'
    ) {
      return false;
    }
    const id = h.requestId;
    if (!id) return false;
    const slot = pending.get(id);
    if (!slot) return false;
    clearTimeout(slot.timer);
    pending.delete(id);
    slot.resolve(h);
    return true;
  }

  return {
    tryConsumeDownstream: consumeDownstream,

    tryConsumeDownstreamFromHost(
      raw: Uint8Array | ArrayBuffer | Buffer,
    ): boolean {
      let msg: WireMessage;
      try {
        msg = protocol.decode(toUint8Array(raw));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.debug(`[ipc] dropped undecodable host frame: ${message}`);
        return false;
      }
      return consumeDownstream(msg);
    },

    async queryCapabilities(timeoutMs = 5000): Promise<CapabilityDescriptor[]> {
      const requestId = newCorrelationId();
      const promise = waitFor<HostCapabilitiesResponseHeader>(
        requestId,
        'HOST_CAPABILITIES_RESPONSE',
        timeoutMs,
      );
      const header = { type: 'HOST_CAPABILITIES_QUERY' as const, requestId };
      writeEncoded(ipc, protocol.encode(MessageType.ENVELOPE, header, null));
      const response = await promise;
      return response.capabilities ?? [];
    },

    async invokeOnHost(
      header: PluginInvokeRequestHeader,
      payload: Uint8Array,
      timeoutMs = DEFAULT_HOST_INVOKE_TIMEOUT_MS,
    ): Promise<PluginInvokeResponseHeader | null> {
      const requestId = header.requestId;
      if (!requestId) return null;

      const promise = waitFor<HostInvokeResponseHeader>(
        requestId,
        'HOST_INVOKE_RESPONSE',
        timeoutMs,
      );
      const hostHeader = {
        type: 'HOST_INVOKE_REQUEST' as const,
        requestId,
        pluginId: header.pluginId,
        event: header.event,
        args: header.args,
      };
      writeEncoded(
        ipc,
        protocol.encode(MessageType.ENVELOPE, hostHeader, payload),
      );
      const hostResp = await promise;
      const out: PluginInvokeResponseHeader = {
        type: 'INVOKE_RESPONSE',
        pluginId: hostResp.pluginId,
        event: hostResp.event,
        requestId: hostResp.requestId,
        result: hostResp.result,
        error: hostResp.error,
      };
      return out;
    },
  };
}
