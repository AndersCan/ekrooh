import {
  createPluginRegistry,
  createPluginRouter,
  definePlugin,
  err,
  ErrorCode,
  MessageType,
  ok,
  type CapabilityDescriptor,
  type PluginInvokeRequestHeader,
  type PluginInvokeResponseHeader,
  type PluginManifest,
  type WireMessage,
} from '../../core/messages';
import { createLogRingBuffer } from '../../core/logs/store';
import { createDiscoveryPlugin } from '../../plugins/discovery/plugin';
import { createHealthPlugin } from '../../plugins/health/plugin';
import { createLogsPlugin } from '../../plugins/logs/plugin';
import { mediaSpecs } from '../../plugins/media/events';
import { isMediaKind } from '../../plugins/media/kinds';
import { isPermissionId } from '../../plugins/permissions/ids';
import { createPermissionsPluginStub } from '../../plugins/permissions/plugin';
import { MessageTransport } from '../websocket-client';

const MOCK_MEDIA_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbUlEQVR4nO3O7UkCABiAQcd5hjXSyCKLPrCiklRswHOM/rw3wS0s4yquYxXruInb2MRd3MdDbOMxnuI5XuI13mIX7/ERn/EV3/ET+/iNQxzjFOf4y2ICE5jABCYwgQlMYAITmMAEJjCBCfx34ALvwBam5OydHgAAAABJRU5ErkJggg==';

/** The host side the mock stands in for: the permission handlers a native
 * host registers. Unknown or missing ids answer `unsupported`, as the real
 * hosts do — the mock never fakes a grant for an id the host would refuse. */
const MOCK_HOST_CAPABILITIES: CapabilityDescriptor[] = [
  {
    pluginId: 'core.permissions',
    capabilities: ['permissions'],
    events: ['permissions.request', 'permissions.status'],
    runtimes: [],
  },
];

async function mockHostInvoke(
  header: PluginInvokeRequestHeader,
): Promise<PluginInvokeResponseHeader> {
  const raw = (header.args as Record<string, unknown> | undefined)?.permission;
  const known = isPermissionId(raw);
  return {
    type: 'INVOKE_RESPONSE',
    pluginId: header.pluginId,
    event: header.event,
    requestId: header.requestId,
    // Known ids are granted (the mock has no user to ask); anything else is
    // `unsupported`, with the id echoed only when it is a string.
    result: {
      permission: typeof raw === 'string' ? raw : '',
      status: known ? 'granted' : 'unsupported',
    },
  };
}

/** `vendor.media` without a native picker or loopback server: same `kind`
 * check as the real plugin, a fixed `data:` image instead of a mounted URL. */
function createMockMediaPlugin(): PluginManifest {
  const pick = (args: { kind?: unknown } | undefined) => {
    const kind = args?.kind;
    if (kind !== undefined && !isMediaKind(kind)) {
      return err(ErrorCode.PLUGIN_ERROR, 'Unknown media kind');
    }
    return ok({ url: MOCK_MEDIA_DATA_URI });
  };
  return definePlugin('vendor.media', mediaSpecs, {
    capabilities: ['media'],
    invoke: { pick, capture: pick },
  });
}

function toPayloadBytes(
  payload: Uint8Array | ArrayBuffer | string | null | undefined,
): Uint8Array {
  if (payload == null) return new Uint8Array(0);
  if (typeof payload === 'string') return new TextEncoder().encode(payload);
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  return payload;
}

let warnedInShell = false;

/** The mock fakes the host (every known permission granted). Inside a real
 * embedding shell that is a shipped test double, so say so loudly once. */
function warnIfInShell() {
  if (warnedInShell || typeof window === 'undefined') return;
  const w = window as Window;
  if (w.BareShell || typeof w.__ekrooh?.bootstrap === 'string') {
    warnedInShell = true;
    console.warn(
      '[ekrooh] createMockTransport is running inside an app shell. It fakes the native host and every permission; it is for tests and browser dev only.',
    );
  }
}

/**
 * Deterministic in-process transport for tests and browser dev. Requests are
 * routed through the real plugin kernel and the real `core.health`,
 * `core.discovery`, `core.logs` and `core.permissions` manifests, so argument
 * checks, unsupported-event errors and discovery match the worklet. Only the
 * host (permission handlers) and `vendor.media` (no native picker, no
 * loopback server: a `data:` URL) are stand-ins.
 */
export function createMockTransport(): MessageTransport {
  warnIfInShell();
  const listeners = new Set<(message: WireMessage) => void>();

  const registry = createPluginRegistry();
  const getHostCapabilities = async () => MOCK_HOST_CAPABILITIES;
  for (const plugin of [
    createHealthPlugin(),
    createDiscoveryPlugin({
      listBareCapabilities: () => registry.listCapabilities(),
      queryHostCapabilities: getHostCapabilities,
    }),
    createPermissionsPluginStub(),
    createMockMediaPlugin(),
    createLogsPlugin({ store: createLogRingBuffer(500) }),
  ]) {
    registry.register(plugin);
  }
  const router = createPluginRouter(registry, 'bare', {
    delegateToHost: mockHostInvoke,
    getHostCapabilities,
    logger: { warn() {}, error() {}, debug() {} },
  });

  return {
    send(type, header, payload) {
      if (type !== MessageType.ENVELOPE || header.type !== 'INVOKE_REQUEST') {
        return;
      }
      void router.route(header, toPayloadBytes(payload)).then((response) => {
        if (!response) return;
        const message: WireMessage = {
          type: MessageType.ENVELOPE,
          header: response,
          payload: new Uint8Array(0),
        };
        for (const listener of listeners) listener(message);
      });
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
