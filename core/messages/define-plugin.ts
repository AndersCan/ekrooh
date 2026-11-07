import { ErrorCode } from './constants';
import { err } from './errors';
import { MAX_TIMER_MS } from './timers';
import {
  CoreError,
  DispatchEnvelope,
  Either,
  InvokeEnvelope,
  PluginContext,
  PluginManifest,
  RuntimeTarget,
} from './types';

/**
 * One event's wire identity and type shape — the single source of truth for
 * the manifest `events` list, the generated handler table, and the typed
 * builders in `events.ts`. `args`/`result` are phantom values that carry the
 * handler and builder types so they can never drift apart.
 */
export interface EventSpec<
  TArgs extends Record<string, unknown> = Record<string, never>,
  TResult = unknown,
> {
  readonly pluginId: string;
  readonly name: string;
  readonly args: TArgs;
  readonly result: TResult;
  /** Runtime check of the untrusted `args` the page sent. `args` is only a
   * compile-time type: nothing else validates it. When present, the generated
   * adapter runs it before the handler and answers `PLUGIN_ERROR` without
   * calling the handler when it returns false. */
  readonly validate?: (args: unknown) => boolean;
  /** Deadline (ms) for this event when the router delegates it to the host.
   * Set it for user-mediated host calls (permission prompts, pickers). */
  readonly hostTimeoutMs?: number;
}

export type InvokeHandler<
  TArgs extends Record<string, unknown> = Record<string, never>,
  TResult = unknown,
> = (
  args: TArgs,
  context: PluginContext,
) => Either<CoreError, TResult> | Promise<Either<CoreError, TResult>>;

export type DispatchHandler<
  TArgs extends Record<string, unknown> = Record<string, never>,
> = (args: TArgs, context: PluginContext) => void | Promise<void>;

type InvokeHandlers<TSpecs extends Record<string, EventSpec<any, any>>> = {
  [K in keyof TSpecs]?: InvokeHandler<TSpecs[K]['args'], TSpecs[K]['result']>;
};

type DispatchHandlers<TSpecs extends Record<string, EventSpec<any, any>>> = {
  [K in keyof TSpecs]?: DispatchHandler<TSpecs[K]['args']>;
};

/**
 * Builds a {@link PluginManifest} from an event spec table. The `events` list
 * is derived from the specs and handlers are dispatched by event name — no
 * hand-written if-chains. Handlers receive typed args. Plugins with no local
 * handlers (host-delegated, e.g. `core.permissions`) pass no `invoke`/`dispatch`.
 */
export function definePlugin<
  const TSpecs extends Record<string, EventSpec<any, any>>,
>(
  id: string,
  specs: TSpecs,
  options: {
    capabilities?: string[];
    invoke?: InvokeHandlers<TSpecs>;
    dispatch?: DispatchHandlers<TSpecs>;
  } = {},
): PluginManifest {
  const invokeByEvent = new Map<string, InvokeHandler<any, any>>();
  const dispatchByEvent = new Map<string, DispatchHandler<any>>();
  const validators = new Map<string, (args: unknown) => boolean>();
  const hostTimeoutsMs: Record<string, number> = Object.create(null);
  const events: string[] = [];

  for (const key of Object.keys(specs) as Array<keyof TSpecs & string>) {
    const spec = specs[key];
    if (spec.pluginId !== id) {
      throw new Error(
        `event spec ${spec.name} belongs to ${spec.pluginId}, not ${id}`,
      );
    }
    events.push(spec.name);
    if (spec.validate) validators.set(spec.name, spec.validate);
    if (
      typeof spec.hostTimeoutMs === 'number' &&
      Number.isFinite(spec.hostTimeoutMs) &&
      spec.hostTimeoutMs > 0
    ) {
      // Capped so a huge value cannot overflow setTimeout into an
      // immediate timeout.
      hostTimeoutsMs[spec.name] = Math.min(spec.hostTimeoutMs, MAX_TIMER_MS);
    }
    const invoker = options.invoke?.[key];
    if (invoker) invokeByEvent.set(spec.name, invoker);
    const dispatcher = options.dispatch?.[key];
    if (dispatcher) dispatchByEvent.set(spec.name, dispatcher);
  }

  /** False when the event's spec has a validator and `args` fails it. */
  const argsValid = (event: string, args: unknown): boolean => {
    const validate = validators.get(event);
    return validate ? validate(args) === true : true;
  };
  const invalidArgs = (event: string) => `Invalid arguments for ${id}.${event}`;

  const adapter: PluginManifest['runtimes'][RuntimeTarget] = {};
  if (invokeByEvent.size > 0) {
    adapter.invoke = (event, args, context) => {
      const handler = invokeByEvent.get(event);
      // A declared event this runtime has no handler for is unsupported here,
      // not a plugin failure.
      if (!handler) {
        return err(
          ErrorCode.UNSUPPORTED_EVENT,
          `Unsupported event ${id}.${event} on ${context.runtime}`,
        );
      }
      if (!argsValid(event, args)) {
        return err(ErrorCode.PLUGIN_ERROR, invalidArgs(event));
      }
      return handler(args as never, context);
    };
  }
  if (dispatchByEvent.size > 0) {
    adapter.dispatch = (event, args, context) => {
      const handler = dispatchByEvent.get(event);
      if (!handler) {
        throw new CoreError(
          ErrorCode.UNSUPPORTED_EVENT,
          `Unsupported event ${id}.${event} on ${context.runtime}`,
        );
      }
      if (!argsValid(event, args)) {
        throw new CoreError(ErrorCode.PLUGIN_ERROR, invalidArgs(event));
      }
      return handler(args as never, context);
    };
  }

  const runtimes: PluginManifest['runtimes'] = {};
  if (invokeByEvent.size > 0 || dispatchByEvent.size > 0) {
    runtimes.bare = adapter;
  }

  const manifest: PluginManifest = {
    id,
    capabilities: options.capabilities,
    events,
    runtimes,
  };
  if (Object.keys(hostTimeoutsMs).length > 0) {
    manifest.hostTimeoutsMs = hostTimeoutsMs;
  }
  return manifest;
}

/** Typed builder: an invoke envelope for a spec's event. */
export function invokeEvent<TSpec extends EventSpec<any, any>>(
  spec: TSpec,
  args: TSpec['args'],
  payload?: Uint8Array | ArrayBuffer | string | null,
  timeoutMs?: number,
): InvokeEnvelope<TSpec['name'], TSpec['args'], TSpec['result']> {
  return {
    kind: 'invoke',
    pluginId: spec.pluginId,
    event: spec.name,
    args,
    payload,
    timeoutMs,
  };
}

/** Typed builder: a dispatch envelope for a spec's event. */
export function dispatchEvent<TSpec extends EventSpec<any, any>>(
  spec: TSpec,
  args: TSpec['args'],
  payload?: Uint8Array | ArrayBuffer | string | null,
): DispatchEnvelope<TSpec['name'], TSpec['args']> {
  return {
    kind: 'dispatch',
    pluginId: spec.pluginId,
    event: spec.name,
    args,
    payload,
  };
}
