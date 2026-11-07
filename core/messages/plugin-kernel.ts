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
import { isShortId, MAX_ID_LENGTH } from './frame-content';
import { isCanonicalErrorCode } from './error-codes';
import { MAX_TIMER_MS } from './timers';

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

/** A plugin id is two or more dot-separated segments of letters, digits, `-`
 * and `_` (`app.photos`), at most {@link MAX_ID_LENGTH} bytes. */
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

/** Namespaces the framework owns. A consumer plugin there could shadow a
 * framework plugin, or collide with one a later release adds. */
const RESERVED_PLUGIN_NAMESPACES = ['core.', 'vendor.'] as const;

/** The framework's own plugins: the only ids allowed in a reserved namespace. */
const FRAMEWORK_PLUGIN_IDS: ReadonlySet<string> = new Set([
  'core.health',
  'core.discovery',
  'core.permissions',
  'core.logs',
  'vendor.media',
]);

export function createPluginRegistry(): PluginRegistry {
  const plugins = new Map<string, PluginManifest>();
  return {
    register(plugin) {
      const id: unknown = plugin.id;
      if (
        typeof id !== 'string' ||
        !isShortId(id) ||
        !PLUGIN_ID_PATTERN.test(id)
      ) {
        throw new Error(
          `plugin id must be namespaced (example: "app.photos": dot-separated letters, digits, "-" or "_"), got "${String(id).slice(0, MAX_ID_LENGTH)}"`,
        );
      }
      if (
        RESERVED_PLUGIN_NAMESPACES.some((ns) => id.startsWith(ns)) &&
        !FRAMEWORK_PLUGIN_IDS.has(id)
      ) {
        throw new Error(
          `plugin id "${id}" is in a namespace reserved for framework plugins (core.*, vendor.*); use your own namespace, e.g. "app.${id.slice(id.indexOf('.') + 1)}"`,
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
    /** Where the message came from. `channel` names the channel it arrived
     * on (e.g. `[ws]`, `[ipc]`); calls with a channel are also held to
     * `maxInflightPerChannel`. */
    context?: { channel?: string },
  ): Promise<PluginInvokeResponseHeader | null>;
}

export type PluginRouterOptions = {
  /** Delegates an invoke to the host. `timeoutMs` is the event's
   * `hostTimeoutMs` from its manifest, when it declares one; otherwise the
   * bridge default applies. */
  delegateToHost?: (
    header: PluginInvokeRequestHeader,
    payload: Uint8Array,
    timeoutMs?: number,
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
  /** Cap on calls routed at once from one channel (see
   * the `channel` passed to `route`), so one peer cannot take every slot: the
   * page cannot starve requests from the host. Defaults to three quarters of
   * `maxInflight`. */
  maxInflightPerChannel?: number;
  /** Cap on calls routed at once to one plugin, so a plugin whose calls are
   * slow cannot take every slot from the others. Defaults to `maxInflight`
   * (no separate cap): a bursty single-plugin app, such as a photo grid, may
   * use every slot. */
  maxInflightPerPlugin?: number;
  /** Plugin ids whose calls must run one at a time, in arrival order. Every
   * other plugin's calls run concurrently, so a slow call never delays them. */
  serialPlugins?: readonly string[];
  /** How long (ms) the host's announced capabilities are reused before the
   * host is asked again. Delegating an invoke otherwise costs an IPC round
   * trip per call. Capabilities the host adds are still picked up within
   * `NEGATIVE_REFRESH_MS`, and a failed delegation drops the cache at once.
   * `0` disables caching (ask the host on every delegation). Defaults to
   * `DEFAULT_HOST_CAPABILITIES_TTL_MS`. */
  hostCapabilitiesTtlMs?: number;
};

const DEFAULT_MAX_INFLIGHT = 64;
const DEFAULT_HOST_CAPABILITIES_TTL_MS = 30_000;
/** An event the cached snapshot does not list triggers a fresh query only once
 * the snapshot is at least this old, so a host that announces a capability
 * late is honored quickly while a stream of calls to an unsupported event
 * cannot turn into a stream of capability queries. */
const NEGATIVE_REFRESH_MS = 2000;

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
  const maxPerChannel =
    options?.maxInflightPerChannel ??
    Math.max(1, Math.floor((maxInflight * 3) / 4));
  const maxPerPlugin = options?.maxInflightPerPlugin ?? maxInflight;
  const serialPlugins = new Set(options?.serialPlugins);
  const serialTails = new Map<string, Promise<unknown>>();
  let inflight = 0;
  // Keyed by channel name / registered plugin id only (unknown plugin ids are
  // answered before they are counted), so both maps stay bounded.
  const inflightByChannel = new Map<string, number>();
  const inflightByPlugin = new Map<string, number>();

  const bump = (map: Map<string, number>, key: string, by: 1 | -1) => {
    const next = (map.get(key) ?? 0) + by;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };

  /** Logs the detail of a thrown error and returns what the peer may see: the
   * code of a canonical `CoreError`, otherwise `fallback`, and a fixed
   * message. Raw exception text (paths, internals) never reaches the page. */
  function thrownError(
    e: unknown,
    fallback: ErrorCode,
    what: string,
  ): CoreError {
    const detail = e instanceof Error ? e.message : String(e);
    logger.error(`${what} failed: ${detail}`);
    const code =
      e instanceof CoreError && isCanonicalErrorCode(e.code)
        ? e.code
        : fallback;
    if (code === ErrorCode.TIMEOUT) {
      return new CoreError(code, `${what} timed out`);
    }
    if (code === ErrorCode.UNSUPPORTED_EVENT) {
      return new CoreError(code, `Unsupported event ${what} on ${runtime}`);
    }
    return new CoreError(code, `${what} failed`);
  }

  const capsTtlMs =
    options?.hostCapabilitiesTtlMs ?? DEFAULT_HOST_CAPABILITIES_TTL_MS;
  let capsCache: { caps: CapabilityDescriptor[]; at: number } | null = null;
  let capsInflight: Promise<CapabilityDescriptor[]> | null = null;

  /** Asks the host for its capabilities. Concurrent callers share one query
   * (calls now overlap, so each would otherwise send its own). A failed query
   * rejects every waiter and is not cached. */
  function queryHostCapabilities(): Promise<CapabilityDescriptor[]> {
    if (capsInflight) return capsInflight;
    const query: Promise<CapabilityDescriptor[]> = (async () =>
      (await options?.getHostCapabilities?.()) ?? [])()
      .then((caps) => {
        capsCache = { caps, at: Date.now() };
        return caps;
      })
      .finally(() => {
        if (capsInflight === query) capsInflight = null;
      });
    capsInflight = query;
    return query;
  }

  /** Whether the host currently announces `pluginId.event`. Served from the
   * cached snapshot while it is fresh; re-queried when it has expired, or when
   * it does not list the event and is old enough to have changed. */
  async function hostAnnounces(
    pluginId: string,
    event: string,
  ): Promise<boolean> {
    if (capsTtlMs > 0 && capsCache) {
      const age = Date.now() - capsCache.at;
      if (age < capsTtlMs) {
        if (isHostRegistered(pluginId, event, capsCache.caps)) return true;
        if (age < NEGATIVE_REFRESH_MS) return false;
      }
    }
    return isHostRegistered(pluginId, event, await queryHostCapabilities());
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
        return invokeErrorResponse(
          header,
          thrownError(
            e,
            ErrorCode.PLUGIN_ERROR,
            `${header.pluginId}.${header.event}`,
          ),
        );
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
          return invokeErrorResponse(
            header,
            thrownError(
              e,
              ErrorCode.PLUGIN_ERROR,
              `${header.pluginId}.${header.event}`,
            ),
          );
        }
      }
      if (header.requestId && options?.delegateToHost) {
        // The capabilities query is host IPC too: a failure there must answer
        // the caller, not escape `route` and leave it waiting (ekrooh#268).
        try {
          if (await hostAnnounces(header.pluginId, header.event)) {
            const delegated = await options.delegateToHost(
              header,
              payload,
              hostTimeoutFor(plugin, header.event),
            );
            if (delegated) {
              // The host disowning the event means our snapshot is stale.
              const code = delegated.error?.code;
              if (
                code === ErrorCode.UNSUPPORTED_CAPABILITY ||
                code === ErrorCode.UNSUPPORTED_EVENT
              ) {
                capsCache = null;
              }
              return delegated;
            }
            capsCache = null;
          }
        } catch (e) {
          capsCache = null;
          return invokeErrorResponse(
            header,
            thrownError(
              e,
              ErrorCode.HOST_ERROR,
              `${header.pluginId}.${header.event}`,
            ),
          );
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
    async route(header, payload, context) {
      if (!isPluginEnvelopeHeader(header)) return routeNow(header, payload);
      const busy = (limit: number, scope: string) => {
        const error = new CoreError(
          ErrorCode.TRANSPORT_ERROR,
          `too many calls in flight${scope} (limit ${limit}); retry later`,
        );
        logger.warn(`${header.pluginId}.${header.event}: ${error.message}`);
        return invokeErrorResponse(header, error);
      };
      if (inflight >= maxInflight) return busy(maxInflight, '');
      const channel = context?.channel;
      if (
        channel !== undefined &&
        (inflightByChannel.get(channel) ?? 0) >= maxPerChannel
      ) {
        return busy(maxPerChannel, ' on this channel');
      }
      // Only registered plugins are counted, so the map is bounded by the
      // registry; an unknown id is answered by routeNow without a slot.
      const pluginKey = registry.get(header.pluginId)
        ? header.pluginId
        : undefined;
      if (
        pluginKey !== undefined &&
        (inflightByPlugin.get(pluginKey) ?? 0) >= maxPerPlugin
      ) {
        return busy(maxPerPlugin, ' for this plugin');
      }
      inflight++;
      if (channel !== undefined) bump(inflightByChannel, channel, 1);
      if (pluginKey !== undefined) bump(inflightByPlugin, pluginKey, 1);
      try {
        return serialPlugins.has(header.pluginId)
          ? await runSerial(header.pluginId, () => routeNow(header, payload))
          : await routeNow(header, payload);
      } finally {
        inflight--;
        if (channel !== undefined) bump(inflightByChannel, channel, -1);
        if (pluginKey !== undefined) bump(inflightByPlugin, pluginKey, -1);
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

/** The manifest's host deadline for `event`, read as an own property. */
function hostTimeoutFor(
  plugin: PluginManifest | undefined,
  event: string,
): number | undefined {
  const timeouts = plugin?.hostTimeoutsMs;
  if (!timeouts || !Object.prototype.hasOwnProperty.call(timeouts, event)) {
    return undefined;
  }
  const value = timeouts[event];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TIMER_MS)
    : undefined;
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
