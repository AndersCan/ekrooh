import { ErrorCode } from './constants';
import {
  CoreError,
  CapabilityDescriptor,
  DispatchEnvelope,
  Either,
  InvokeEnvelope,
  MessageHeader,
  PluginDispatchHeader,
  PluginInvokeRequestHeader,
  PluginInvokeResponseHeader,
  PluginManifest,
  RuntimeTarget,
} from './types';
import { InvokeRequest, ProtocolMessenger } from './rpc-messenger';

export interface PluginRegistry {
  register(plugin: PluginManifest): void;
  resolve(
    pluginId: string,
    runtime: RuntimeTarget,
  ): PluginManifest['runtimes'][RuntimeTarget] | undefined;
  get(pluginId: string): PluginManifest | undefined;
  listCapabilities(runtime?: RuntimeTarget): Array<{
    pluginId: string;
    capabilities: string[];
    events: string[];
    runtimes: RuntimeTarget[];
  }>;
}

export function createPluginRegistry(): PluginRegistry {
  const plugins = new Map<string, PluginManifest>();
  return {
    register(plugin) {
      if (!plugin.id.includes('.')) {
        throw new Error(
          `plugin id must be namespaced (example: "vendor.plugin"), got "${plugin.id}"`,
        );
      }
      if (plugins.has(plugin.id)) {
        throw new Error(`plugin id "${plugin.id}" is already registered`);
      }
      plugins.set(plugin.id, plugin);
    },
    resolve(pluginId, runtime) {
      const plugin = plugins.get(pluginId);
      return plugin?.runtimes[runtime];
    },
    get(pluginId) {
      return plugins.get(pluginId);
    },
    listCapabilities(runtime) {
      const rows: Array<{
        pluginId: string;
        capabilities: string[];
        events: string[];
        runtimes: RuntimeTarget[];
      }> = [];
      for (const plugin of plugins.values()) {
        const runtimes = Object.keys(plugin.runtimes) as RuntimeTarget[];
        if (runtime && !runtimes.includes(runtime)) continue;
        rows.push({
          pluginId: plugin.id,
          capabilities: plugin.capabilities ?? [],
          events: plugin.events ?? [],
          runtimes,
        });
      }
      return rows;
    },
  };
}

export interface PluginRouter {
  route(
    header: MessageHeader,
    payload: Uint8Array,
  ): Promise<PluginInvokeResponseHeader | null>;
}

export type PluginRouterOptions = {
  delegateToHost?: (
    header: PluginInvokeRequestHeader,
    payload: Uint8Array,
  ) => Promise<PluginInvokeResponseHeader | null>;
  /** Host-registered capabilities (from `HOST_CAPABILITIES_RESPONSE`).
   * Delegation to the host is only permitted for events the host announces
   * here — a deny-by-default allowlist. When omitted or empty, no
   * host-delegated invokes are allowed. */
  getHostCapabilities?: () => Promise<CapabilityDescriptor[]>;
  logger?: Pick<Console, 'warn' | 'error' | 'debug'>;
  /** Global cap on calls routed at once (running or queued behind a serial
   * plugin). A call over the cap is answered with a `TRANSPORT_ERROR` instead
   * of being queued, so a flood cannot grow memory without bound. Defaults to
   * `DEFAULT_MAX_INFLIGHT`. */
  maxInflight?: number;
  /** Plugin ids whose calls must run one at a time, in arrival order. Every
   * other plugin's calls run concurrently, so a slow call never delays them. */
  serialPlugins?: readonly string[];
};

const DEFAULT_MAX_INFLIGHT = 64;

/** Whether the router may synthesize an UNSUPPORTED_EVENT response. Events are
 * only gated when the manifest declares them; a plugin with no manifest/owner
 * declares nothing and is rejected. */
function declaresEvent(plugin: PluginManifest | undefined, event: string) {
  if (!plugin) return false;
  if (!plugin.events) return false;
  return plugin.events.includes(event);
}

export function createPluginRouter(
  registry: PluginRegistry,
  runtime: RuntimeTarget,
  options?: PluginRouterOptions,
): PluginRouter {
  const logger = options?.logger ?? console;
  const maxInflight = options?.maxInflight ?? DEFAULT_MAX_INFLIGHT;
  const serialPlugins = new Set(options?.serialPlugins);
  const serialTails = new Map<string, Promise<unknown>>();
  let inflight = 0;

  /** Fresh host capabilities on every delegation decision — never memoized, so
   * abilities the host announces/withdraws after the first delegated invoke
   * take effect immediately. */
  async function hostCapabilities(): Promise<CapabilityDescriptor[]> {
    return (await options?.getHostCapabilities?.()) ?? [];
  }

  /** Deny-by-default host-delegation allowlist: an event can only be delegated
   * once the host has announced it via `HOST_CAPABILITIES_RESPONSE`. */
  function isHostRegistered(
    pluginId: string,
    event: string,
    caps: CapabilityDescriptor[],
  ): boolean {
    const row = caps.find((c) => c.pluginId === pluginId);
    return row ? row.events.includes(event) : false;
  }

  /** Runs `task` after the previous call to the same serial plugin settles, so
   * a failing call never wedges the queue behind it. */
  function runSerial<T>(pluginId: string, task: () => Promise<T>): Promise<T> {
    const tail = serialTails.get(pluginId) ?? Promise.resolve();
    const run = tail.then(task, task);
    const next = run.catch(() => undefined);
    serialTails.set(pluginId, next);
    void next.then(() => {
      if (serialTails.get(pluginId) === next) serialTails.delete(pluginId);
    });
    return run;
  }

  async function routeNow(
    header: MessageHeader,
    payload: Uint8Array,
  ): Promise<PluginInvokeResponseHeader | null> {
    const plugin = isPluginEnvelopeHeader(header)
      ? registry.get(header.pluginId)
      : undefined;

    if (isPluginEnvelopeHeader(header)) {
      if (!declaresEvent(plugin, header.event)) {
        const error = new CoreError(
          ErrorCode.UNSUPPORTED_EVENT,
          `Unsupported event ${header.pluginId}.${header.event} on ${runtime}`,
        );
        if (isPluginDispatchHeader(header)) {
          logger.warn(error.message);
        }
        return invokeErrorResponse(header, error);
      }
    }

    if (isPluginDispatchHeader(header)) {
      const runtimeAdapter = registry.resolve(header.pluginId, runtime);
      if (!runtimeAdapter?.dispatch) {
        const error = new CoreError(
          ErrorCode.UNSUPPORTED_CAPABILITY,
          `Unsupported capability ${header.pluginId}.${header.event} on ${runtime}`,
        );
        logger.warn(error.message);
        return invokeErrorResponse(header, error);
      }
      try {
        await runtimeAdapter.dispatch(header.event, header.args, {
          runtime,
          payload,
          sender: { pluginId: header.pluginId },
        });
        return null;
      } catch (e) {
        const error = new CoreError(
          ErrorCode.PLUGIN_ERROR,
          e instanceof Error ? e.message : String(e),
        );
        logger.error(
          `dispatch ${header.pluginId}.${header.event} failed: ${error.message}`,
        );
        return invokeErrorResponse(header, error);
      }
    }

    if (isPluginInvokeRequestHeader(header)) {
      const runtimeAdapter = registry.resolve(header.pluginId, runtime);
      if (runtimeAdapter?.invoke) {
        try {
          const result = await runtimeAdapter.invoke(
            header.event,
            header.args,
            {
              runtime,
              payload,
              sender: { pluginId: header.pluginId },
            },
          );
          const [error, okResult] = result;
          return {
            type: 'INVOKE_RESPONSE',
            pluginId: header.pluginId,
            event: header.event,
            requestId: header.requestId,
            result: okResult ?? undefined,
            error: error
              ? { code: error.code, message: error.message }
              : undefined,
          };
        } catch (e) {
          const error = new CoreError(
            ErrorCode.PLUGIN_ERROR,
            e instanceof Error ? e.message : String(e),
          );
          logger.error(
            `invoke ${header.pluginId}.${header.event} failed: ${error.message}`,
          );
          return invokeErrorResponse(header, error);
        }
      }
      if (header.requestId && options?.delegateToHost) {
        const caps = await hostCapabilities();
        if (isHostRegistered(header.pluginId, header.event, caps)) {
          try {
            const delegated = await options.delegateToHost(header, payload);
            if (delegated) {
              return delegated;
            }
          } catch (e) {
            return invokeErrorResponse(
              header,
              new CoreError(
                ErrorCode.HOST_ERROR,
                e instanceof Error ? e.message : String(e),
              ),
            );
          }
        }
      }
      return invokeErrorResponse(
        header,
        new CoreError(
          ErrorCode.UNSUPPORTED_CAPABILITY,
          `Unsupported capability ${header.pluginId}.${header.event} on ${runtime}`,
        ),
      );
    }

    return null;
  }

  return {
    async route(header, payload) {
      if (!isPluginEnvelopeHeader(header)) return routeNow(header, payload);
      if (inflight >= maxInflight) {
        const error = new CoreError(
          ErrorCode.TRANSPORT_ERROR,
          `too many calls in flight (limit ${maxInflight}); retry later`,
        );
        logger.warn(`${header.pluginId}.${header.event}: ${error.message}`);
        return invokeErrorResponse(header, error);
      }
      inflight++;
      try {
        return serialPlugins.has(header.pluginId)
          ? await runSerial(header.pluginId, () => routeNow(header, payload))
          : await routeNow(header, payload);
      } finally {
        inflight--;
      }
    },
  };
}

export interface PluginBus {
  dispatch(envelope: DispatchEnvelope): string;
  invoke<TResult>(
    envelope: InvokeEnvelope<string, Record<string, unknown>, TResult>,
  ): Promise<Either<CoreError, TResult>>;
}

export function createPluginBus(messenger: ProtocolMessenger): PluginBus {
  return {
    dispatch(envelope) {
      return messenger.dispatch({
        type: 'DISPATCH',
        pluginId: envelope.pluginId,
        event: envelope.event,
        args: envelope.args,
      });
    },
    async invoke<TResult>(
      envelope: InvokeEnvelope<string, Record<string, unknown>, TResult>,
    ) {
      let response: MessageHeader;
      try {
        response = await messenger.invoke(
          {
            type: 'INVOKE_REQUEST',
            pluginId: envelope.pluginId,
            event: envelope.event,
            args: envelope.args,
          } as InvokeRequest,
          envelope.payload ?? null,
          envelope.timeoutMs,
        );
      } catch (error) {
        // Transport-level failures (invoke timeout, backpressure drop) reject
        // rather than answer. They must honor the Either contract like any
        // other failed call — throwing past callers leaves their UI state on
        // the initial "not run yet" text with nothing rendered or logged.
        const message = error instanceof Error ? error.message : String(error);
        return [
          new CoreError(
            message.startsWith('invoke timeout')
              ? ErrorCode.TIMEOUT
              : ErrorCode.INVALID_RESPONSE,
            message,
          ),
          null,
        ];
      }

      if (isPluginInvokeResponseHeader(response)) {
        if (response.error) {
          // App-scoped codes (e.g. `app.photos/not-found`) ride the wire
          // verbatim — never flattened to a canonical code.
          const typedError = new CoreError(
            response.error.code,
            String(response.error.message ?? 'Plugin invoke failed'),
          );
          return [typedError, null];
        }
        return [null, response.result as TResult];
      }

      return [
        new CoreError(
          ErrorCode.INVALID_RESPONSE,
          `Unexpected response type ${response.type}`,
        ),
        null,
      ];
    },
  };
}

function invokeErrorResponse(
  header: PluginDispatchHeader | PluginInvokeRequestHeader,
  error: CoreError,
): PluginInvokeResponseHeader {
  return {
    type: 'INVOKE_RESPONSE',
    pluginId: header.pluginId,
    event: header.event,
    requestId: header.requestId,
    error: { code: error.code, message: error.message },
  };
}

function isPluginDispatchHeader(
  header: MessageHeader,
): header is PluginDispatchHeader {
  return (
    header.type === 'DISPATCH' &&
    typeof header.pluginId === 'string' &&
    typeof header.event === 'string'
  );
}

function isPluginEnvelopeHeader(
  header: MessageHeader,
): header is PluginDispatchHeader | PluginInvokeRequestHeader {
  return isPluginDispatchHeader(header) || isPluginInvokeRequestHeader(header);
}

function isPluginInvokeRequestHeader(
  header: MessageHeader,
): header is PluginInvokeRequestHeader {
  return (
    header.type === 'INVOKE_REQUEST' &&
    typeof header.pluginId === 'string' &&
    typeof header.event === 'string'
  );
}

function isPluginInvokeResponseHeader(
  header: MessageHeader,
): header is PluginInvokeResponseHeader {
  return (
    header.type === 'INVOKE_RESPONSE' &&
    typeof header.pluginId === 'string' &&
    typeof header.event === 'string'
  );
}
