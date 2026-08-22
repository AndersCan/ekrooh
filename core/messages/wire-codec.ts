import {
  ErrorCode,
  MAX_FRAME_BYTES,
  MAX_HEADER_BYTES,
  MessageType,
  MessageTypeValue,
  VERSION,
} from './constants';
import {
  WireMessage,
  CapabilityDescriptor,
  CoreError,
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
  /** Override the default {@link MAX_FRAME_BYTES} cap. Clamped to a sane
   * range: it must be large enough to hold the largest legal header, and never
   * larger than {@link MAX_FRAME_BYTES}. `Infinity`/`NaN`/negative inputs
   * collapse to the defaults so a caller cannot disable the decode-side cap. */
  maxFrameBytes?: number;
}

/** Smallest frame that can legally carry a maximum-size header. Below this the
 * decoder could never extract a header, so it is the effective floor for the
 * frame cap. */
const MIN_FRAME_BYTES = MAX_HEADER_BYTES + 4;

function clampFrameBytes(value: number): number {
  const fallback = Number.isFinite(value) ? Math.floor(value) : MAX_FRAME_BYTES;
  return Math.min(Math.max(fallback, MIN_FRAME_BYTES), MAX_FRAME_BYTES);
}

export class MessageProtocol {
  private encodeStr: Encoder;
  private decodeStr: Decoder;
  private allowUnknownTypes: boolean;
  /** Resolved, clamped frame cap. Public so callers/tests can inspect the
   * effective limit after clamping. */
  readonly maxFrameBytes: number;

  constructor(options?: ProtocolOptions) {
    this.encodeStr =
      options?.encode || ((str) => new TextEncoder().encode(str));
    this.decodeStr =
      options?.decode ||
      ((bytes) => new TextDecoder(undefined, { fatal: true }).decode(bytes));
    this.allowUnknownTypes = options?.allowUnknownTypes ?? false;
    this.maxFrameBytes = clampFrameBytes(
      options?.maxFrameBytes ?? MAX_FRAME_BYTES,
    );
  }

  encode(
    type: MessageTypeValue,
    header: MessageHeader,
    payload?: Uint8Array | ArrayBuffer | string | null,
  ): Uint8Array {
    const headerJson = JSON.stringify(header);
    const headerBytes = this.encodeStr(headerJson);

    if (headerBytes.byteLength > MAX_HEADER_BYTES) {
      throw new Error(
        `Header too large: ${headerBytes.byteLength} bytes, maximum is ${MAX_HEADER_BYTES}`,
      );
    }

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

    if (totalLength > this.maxFrameBytes) {
      throw new Error(
        `Frame too large: ${totalLength} bytes, maximum is ${this.maxFrameBytes}`,
      );
    }

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

    if (byteLength > this.maxFrameBytes) {
      throw new Error(
        `Frame too large: ${byteLength} bytes, maximum is ${this.maxFrameBytes}`,
      );
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

    let headerStr: string;
    try {
      headerStr = this.decodeStr(view.subarray(4, 4 + headerLen));
    } catch {
      throw new CoreError(
        ErrorCode.FRAME_INVALID,
        'FRAME_INVALID: header frame is not valid UTF-8',
      );
    }
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
  switch (header.type) {
    case 'DISPATCH':
      if (isValidPluginHeaderFields(header)) {
        return mergeHeader(header, {
          type: 'DISPATCH',
          pluginId: header.pluginId,
          event: header.event,
          requestId: asOptionalString(header.requestId),
          args: asOptionalRecord(header.args),
        });
      }
      break;
    case 'INVOKE_REQUEST':
      if (isValidPluginHeaderFields(header)) {
        return mergeHeader(header, {
          type: 'INVOKE_REQUEST',
          pluginId: header.pluginId,
          event: header.event,
          requestId: asOptionalString(header.requestId),
          args: asOptionalRecord(header.args),
        });
      }
      break;
    case 'INVOKE_RESPONSE':
      if (isValidPluginHeaderFields(header)) {
        return mergeHeader(header, {
          type: 'INVOKE_RESPONSE',
          pluginId: header.pluginId,
          event: header.event,
          requestId: asOptionalString(header.requestId),
          result: sanitizeValue(header.result, 0),
          error: parseCoreErrorWire(header.error),
        });
      }
      break;
    case 'HOST_CAPABILITIES_QUERY':
      if (typeof header.requestId === 'string') {
        return mergeHeader(header, {
          type: 'HOST_CAPABILITIES_QUERY',
          requestId: header.requestId,
        });
      }
      break;
    case 'HOST_CAPABILITIES_RESPONSE':
      if (typeof header.requestId === 'string') {
        return mergeHeader(header, {
          type: 'HOST_CAPABILITIES_RESPONSE',
          requestId: header.requestId,
          capabilities: parseCapabilityDescriptors(header.capabilities),
        });
      }
      break;
    case 'HOST_INVOKE_REQUEST':
      if (
        typeof header.requestId === 'string' &&
        typeof header.pluginId === 'string' &&
        typeof header.event === 'string'
      ) {
        return mergeHeader(header, {
          type: 'HOST_INVOKE_REQUEST',
          requestId: header.requestId,
          pluginId: header.pluginId,
          event: header.event,
          args: asOptionalRecord(header.args),
        });
      }
      break;
    case 'HOST_INVOKE_RESPONSE':
      if (
        typeof header.requestId === 'string' &&
        typeof header.pluginId === 'string' &&
        typeof header.event === 'string'
      ) {
        return mergeHeader(header, {
          type: 'HOST_INVOKE_RESPONSE',
          requestId: header.requestId,
          pluginId: header.pluginId,
          event: header.event,
          result: sanitizeValue(header.result, 0),
          error: parseCoreErrorWire(header.error),
        });
      }
      break;
  }
  throw new Error(`Unsupported header type: ${String(header.type)}`);
}

/** Only allowlisted, schema-known fields are carried forward. Unknown wire
 * fields are dropped so attacker-controlled keys (e.g. `__proto__` or an
 * arbitrary `args` key) never ride into plugin args/result objects. */
function mergeHeader<T extends MessageHeader>(
  parsed: Record<string, unknown>,
  known: T,
): T {
  return known;
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
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  return sanitizeValue(value, 0) as Record<string, unknown>;
}

/** Recursively copy an attacker-controlled value onto a `null`-prototype object,
 * dropping prototype-polluting keys (`__proto__`/`constructor`/`prototype`) and
 * rejecting excessive nesting (depth bombs carried inside the 64KB header
 * budget). Throws {@link ErrorCode.FRAME_INVALID} on over-deep structures. */
const MAX_VALUE_DEPTH = 16;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_VALUE_DEPTH) {
    throw new CoreError(
      ErrorCode.FRAME_INVALID,
      `FRAME_INVALID: value nested deeper than ${MAX_VALUE_DEPTH} levels`,
    );
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    out[key] = sanitizeValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
    );
  }
  return out;
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
