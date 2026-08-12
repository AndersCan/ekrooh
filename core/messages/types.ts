import { ErrorCode, MessageTypeValue } from './constants';

/** Decoded binary frame (version byte stripped); used by WebSocket and other transports. */
export interface WireMessage {
  type: MessageTypeValue;
  header: MessageHeader;
  payload: Uint8Array;
}

type HeaderBase = {
  type: string;
  requestId?: string;
};

/** Canonical wire codes plus any app-scoped code consumers define (e.g.
 * `app.photos/not-found`). Framework plugins use the canonical union;
 * arbitrary codes ride the wire verbatim and are never flattened. */
export type ErrorCodeOrString = ErrorCode | (string & {});

export class CoreError extends Error {
  code: ErrorCodeOrString;

  constructor(code: ErrorCodeOrString, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

export type CoreErrorWire = {
  code: string;
  message: string;
};

export type RuntimeTarget = 'web' | 'android' | 'ios' | 'bare';
export type Either<E, A> = [E, null] | [null, A];

export type DispatchEnvelope<
  TEvent extends string = string,
  TArgs extends Record<string, unknown> = Record<string, unknown>,
> = {
  kind: 'dispatch';
  pluginId: string;
  event: TEvent;
  args: TArgs;
  payload?: Uint8Array | ArrayBuffer | string | null;
};

export type InvokeEnvelope<
  TEvent extends string = string,
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> = {
  kind: 'invoke';
  pluginId: string;
  event: TEvent;
  args: TArgs;
  payload?: Uint8Array | ArrayBuffer | string | null;
  timeoutMs?: number;
  __result?: TResult;
};

export type PluginInvokeRequestHeader = HeaderBase & {
  type: 'INVOKE_REQUEST';
  pluginId: string;
  event: string;
  args?: Record<string, unknown>;
};

export type PluginInvokeResponseHeader = HeaderBase & {
  type: 'INVOKE_RESPONSE';
  pluginId: string;
  event: string;
  result?: unknown;
  error?: CoreErrorWire;
};

export type PluginDispatchHeader = HeaderBase & {
  type: 'DISPATCH';
  pluginId: string;
  event: string;
  args?: Record<string, unknown>;
};

export type PluginHeader =
  | PluginInvokeRequestHeader
  | PluginInvokeResponseHeader
  | PluginDispatchHeader;

/** Worklet → host: ask for merged capability list (host registry + static knowledge). */
export type HostCapabilitiesQueryHeader = {
  type: 'HOST_CAPABILITIES_QUERY';
  requestId: string;
};

/** Host → worklet: capability rows contributed by the host. */
export type HostCapabilitiesResponseHeader = {
  type: 'HOST_CAPABILITIES_RESPONSE';
  requestId: string;
  capabilities: CapabilityDescriptor[];
};

/** Worklet → host: run a host-registered handler (same pluginId/event as frontend invokes). */
export type HostInvokeRequestHeader = {
  type: 'HOST_INVOKE_REQUEST';
  requestId: string;
  pluginId: string;
  event: string;
  args?: Record<string, unknown>;
};

/** Host → worklet: result for {@link HostInvokeRequestHeader}. */
export type HostInvokeResponseHeader = {
  type: 'HOST_INVOKE_RESPONSE';
  requestId: string;
  pluginId: string;
  event: string;
  result?: unknown;
  error?: CoreErrorWire;
};

/** Serializable row for discovery and host registry listing. */
export type CapabilityDescriptor = {
  pluginId: string;
  capabilities: string[];
  events: string[];
  runtimes: RuntimeTarget[];
};

export type MessageHeader =
  | PluginHeader
  | HostCapabilitiesQueryHeader
  | HostCapabilitiesResponseHeader
  | HostInvokeRequestHeader
  | HostInvokeResponseHeader;

export interface PluginContext {
  runtime: RuntimeTarget;
  payload: Uint8Array;
}

export interface PluginRuntimeAdapter {
  dispatch?: (
    event: string,
    args: Record<string, unknown> | undefined,
    context: PluginContext,
  ) => void | Promise<void>;
  invoke?: (
    event: string,
    args: Record<string, unknown> | undefined,
    context: PluginContext,
  ) => Either<CoreError, unknown> | Promise<Either<CoreError, unknown>>;
}

export interface PluginManifest {
  id: string;
  version?: string;
  capabilities?: string[];
  events?: string[];
  runtimes: Partial<Record<RuntimeTarget, PluginRuntimeAdapter>>;
}
