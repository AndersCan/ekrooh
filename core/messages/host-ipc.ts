import { MessageType } from './constants';
import { MessageProtocol } from './wire-codec';
import type {
  CapabilityDescriptor,
  HostCapabilitiesResponseHeader,
  HostInvokeResponseHeader,
  MessageHeader,
  PluginInvokeRequestHeader,
  PluginInvokeResponseHeader,
} from './types';

function toUint8Array(data: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data))
    return new Uint8Array(data);
  return new Uint8Array(data);
}

function newCorrelationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type Pending = {
  resolve: (h: MessageHeader) => void;
  timer: ReturnType<typeof setTimeout>;
};

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
      pending.set(requestId, {
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
      });
    });
  }

  return {
    tryConsumeDownstreamFromHost(
      raw: Uint8Array | ArrayBuffer | Buffer,
    ): boolean {
      let msg;
      try {
        msg = protocol.decode(toUint8Array(raw));
      } catch {
        return false;
      }
      const h = msg.header;
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
      timeoutMs = 300000,
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
