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
  const events: string[] = [];

  for (const key of Object.keys(specs) as Array<keyof TSpecs & string>) {
    const spec = specs[key];
    if (spec.pluginId !== id) {
      throw new Error(
        `event spec ${spec.name} belongs to ${spec.pluginId}, not ${id}`,
      );
    }
    events.push(spec.name);
    const invoker = options.invoke?.[key];
    if (invoker) invokeByEvent.set(spec.name, invoker);
    const dispatcher = options.dispatch?.[key];
    if (dispatcher) dispatchByEvent.set(spec.name, dispatcher);
  }

  const adapter: PluginManifest['runtimes'][RuntimeTarget] = {};
  if (invokeByEvent.size > 0) {
    adapter.invoke = (event, args, context) => {
      const handler = invokeByEvent.get(event);
      if (!handler) throw new Error(`Unhandled invoke event ${event}`);
      return handler(args as never, context);
    };
  }
  if (dispatchByEvent.size > 0) {
    adapter.dispatch = (event, args, context) => {
      const handler = dispatchByEvent.get(event);
      if (!handler) throw new Error(`Unhandled dispatch event ${event}`);
      return handler(args as never, context);
    };
  }

  const runtimes: PluginManifest['runtimes'] = {};
  if (invokeByEvent.size > 0 || dispatchByEvent.size > 0) {
    runtimes.bare = adapter;
  }

  return {
    id,
    capabilities: options.capabilities,
    events,
    runtimes,
  };
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
