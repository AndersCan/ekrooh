import { MessageType, MessageTypeValue, VERSION } from './constants';
import {
  WireMessage,
  CapabilityDescriptor,
  CoreErrorWire,
  MessageHeader,
  RuntimeTarget,
} from './types';

export type Encoder = (str: string) => Uint8Array;
export type Decoder = (bytes: Uint8Array) => string;

export interface ProtocolOptions {
  encode?: Encoder;
  decode?: Decoder;
  allowUnknownTypes?: boolean;
}

export class MessageProtocol {
  private encodeStr: Encoder;
  private decodeStr: Decoder;
  private allowUnknownTypes: boolean;

  constructor(options?: ProtocolOptions) {
    this.encodeStr =
      options?.encode || ((str) => new TextEncoder().encode(str));
    this.decodeStr =
      options?.decode || ((bytes) => new TextDecoder().decode(bytes));
    this.allowUnknownTypes = options?.allowUnknownTypes ?? false;
  }

  encode(
    type: MessageTypeValue,
    header: MessageHeader,
    payload?: Uint8Array | ArrayBuffer | string | null,
  ): Uint8Array {
    const headerJson = JSON.stringify(header);
    const headerBytes = this.encodeStr(headerJson);

    let payloadBytes: Uint8Array;
    if (payload == null) {
      payloadBytes = new Uint8Array(0);
    } else if (typeof payload === 'string') {
      payloadBytes = this.encodeStr(payload);
    } else if (payload instanceof ArrayBuffer) {
      payloadBytes = new Uint8Array(payload);
    } else {
      payloadBytes = payload;
    }

    const hLen = headerBytes.byteLength;
    const pLen = payloadBytes.byteLength;
    const totalLength = 4 + hLen + pLen;

    let buffer: Uint8Array;
    if (
      typeof Buffer !== 'undefined' &&
      typeof Buffer.allocUnsafe === 'function'
    ) {
      buffer = Buffer.allocUnsafe(totalLength);
    } else {
      buffer = new Uint8Array(totalLength);
    }

    buffer[0] = VERSION;
    buffer[1] = type;
    buffer[2] = (hLen >> 8) & 0xff;
    buffer[3] = hLen & 0xff;
    buffer.set(headerBytes, 4);
    if (pLen > 0) {
      buffer.set(payloadBytes, 4 + hLen);
    }

    return buffer;
  }

  decode(data: ArrayBuffer | Uint8Array): WireMessage {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    const byteLength = view.byteLength;

    if (byteLength < 4) {
      throw new Error(`Message too short: ${byteLength} bytes`);
    }

    const version = view[0];
    if (version !== VERSION) {
      throw new Error(`Unsupported version: ${version}. Expected ${VERSION}`);
    }

    const type = view[1] as MessageTypeValue;
    if (!this.allowUnknownTypes && !isKnownMessageType(type)) {
      throw new Error(`Unsupported message type: ${type}`);
    }
    const headerLen = (view[2] << 8) | view[3];

    if (byteLength < 4 + headerLen) {
      throw new Error(
        `Message too short for header: ${byteLength} bytes, expected at least ${4 + headerLen}`,
      );
    }

    const headerStr = this.decodeStr(view.subarray(4, 4 + headerLen));
    const header = parseAndValidateHeader(headerStr);
    const payload = view.subarray(4 + headerLen);

    return { type, header, payload };
  }
}

function isKnownMessageType(type: number): type is MessageTypeValue {
  return Object.values(MessageType).includes(type as MessageTypeValue);
}

function parseAndValidateHeader(headerJson: string): MessageHeader {
  const parsed = JSON.parse(headerJson) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid header: expected object');
  }
  const header = parsed as Record<string, unknown>;
  if (header.type === 'DISPATCH' && isValidPluginHeaderFields(header)) {
    return {
      type: 'DISPATCH',
      pluginId: header.pluginId,
      event: header.event,
      requestId: asOptionalString(header.requestId),
      args: asOptionalRecord(header.args),
    };
  }
  if (header.type === 'INVOKE_REQUEST' && isValidPluginHeaderFields(header)) {
    return {
      type: 'INVOKE_REQUEST',
      pluginId: header.pluginId,
      event: header.event,
      requestId: asOptionalString(header.requestId),
      args: asOptionalRecord(header.args),
    };
  }
  if (header.type === 'INVOKE_RESPONSE' && isValidPluginHeaderFields(header)) {
    return {
      type: 'INVOKE_RESPONSE',
      pluginId: header.pluginId,
      event: header.event,
      requestId: asOptionalString(header.requestId),
      result: header.result,
      error: parseCoreErrorWire(header.error),
    };
  }
  if (
    header.type === 'HOST_CAPABILITIES_QUERY' &&
    typeof header.requestId === 'string'
  ) {
    return { type: 'HOST_CAPABILITIES_QUERY', requestId: header.requestId };
  }
  if (
    header.type === 'HOST_CAPABILITIES_RESPONSE' &&
    typeof header.requestId === 'string'
  ) {
    return {
      type: 'HOST_CAPABILITIES_RESPONSE',
      requestId: header.requestId,
      capabilities: parseCapabilityDescriptors(header.capabilities),
    };
  }
  if (
    header.type === 'HOST_INVOKE_REQUEST' &&
    typeof header.requestId === 'string' &&
    typeof header.pluginId === 'string' &&
    typeof header.event === 'string'
  ) {
    return {
      type: 'HOST_INVOKE_REQUEST',
      requestId: header.requestId,
      pluginId: header.pluginId,
      event: header.event,
      args: asOptionalRecord(header.args),
    };
  }
  if (
    header.type === 'HOST_INVOKE_RESPONSE' &&
    typeof header.requestId === 'string' &&
    typeof header.pluginId === 'string' &&
    typeof header.event === 'string'
  ) {
    return {
      type: 'HOST_INVOKE_RESPONSE',
      requestId: header.requestId,
      pluginId: header.pluginId,
      event: header.event,
      result: header.result,
      error: parseCoreErrorWire(header.error),
    };
  }
  throw new Error(`Unsupported header type: ${String(header.type)}`);
}

function isValidPluginHeaderFields(
  header: Record<string, unknown>,
): header is Record<string, unknown> & { pluginId: string; event: string } {
  return (
    typeof header.pluginId === 'string' && typeof header.event === 'string'
  );
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseCoreErrorWire(value: unknown): CoreErrorWire | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.code !== 'string' ||
    typeof candidate.message !== 'string'
  )
    return undefined;
  return { code: candidate.code, message: candidate.message };
}

const RUNTIME_TARGETS = new Set<RuntimeTarget>([
  'web',
  'android',
  'ios',
  'bare',
]);

function parseRuntimeTarget(value: unknown): RuntimeTarget | null {
  if (typeof value !== 'string') return null;
  return RUNTIME_TARGETS.has(value as RuntimeTarget)
    ? (value as RuntimeTarget)
    : null;
}

function parseCapabilityDescriptors(value: unknown): CapabilityDescriptor[] {
  if (!Array.isArray(value)) return [];
  const out: CapabilityDescriptor[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.pluginId !== 'string') continue;
    const events = Array.isArray(r.events)
      ? r.events.filter((e): e is string => typeof e === 'string')
      : [];
    const caps = Array.isArray(r.capabilities)
      ? r.capabilities.filter((c): c is string => typeof c === 'string')
      : [];
    const runtimes: RuntimeTarget[] = [];
    if (Array.isArray(r.runtimes)) {
      for (const rt of r.runtimes) {
        const parsed = parseRuntimeTarget(rt);
        if (parsed) runtimes.push(parsed);
      }
    }
    out.push({
      pluginId: r.pluginId,
      capabilities: caps,
      events,
      runtimes,
    });
  }
  return out;
}
