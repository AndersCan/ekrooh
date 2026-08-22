import { ErrorCode, MessageType, WireMessage } from '../../core/messages';
import {
  createHealthInvokeHandlers,
  createLogsInvokeHandlers,
  type MockInvokeHandler,
} from './mock-handlers';
import { createLogRingBuffer } from '../../core/logs/store';
import { MessageTransport } from '../websocket-client';

const MOCK_MEDIA_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbUlEQVR4nO3O7UkCABiAQcd5hjXSyCKLPrCiklRswHOM/rw3wS0s4yquYxXruInb2MRd3MdDbOMxnuI5XuI13mIX7/ERn/EV3/ET+/iNQxzjFOf4y2ICE5jABCYwgQlMYAITmMAEJjCBCfx34ALvwBam5OydHgAAAABJRU5ErkJggg==';

const permissionOf = (args?: Record<string, unknown>): string =>
  typeof args?.permission === 'string' ? args.permission : 'storage';

const mockInvokeHandlers: Record<string, MockInvokeHandler> = {
  ...createHealthInvokeHandlers(),
  ...createLogsInvokeHandlers(createLogRingBuffer(500)),
  'discovery.list': () => ({
    schemaVersion: 1 as const,
    capabilities: [
      {
        pluginId: 'core.health',
        capabilities: [],
        events: ['health.ping', 'health.payloadEcho', 'health.roundtrip'],
        runtimes: ['bare'],
      },
      {
        pluginId: 'core.discovery',
        capabilities: ['discovery'],
        events: ['discovery.list'],
        runtimes: ['bare'],
      },
      {
        pluginId: 'core.permissions',
        capabilities: ['permissions'],
        events: ['permissions.request', 'permissions.status'],
        runtimes: [],
      },
      {
        pluginId: 'vendor.media',
        capabilities: ['media'],
        events: ['media.pick', 'media.capture'],
        runtimes: ['bare'],
      },
    ],
  }),
  'permissions.request': (args) => ({
    permission: permissionOf(args),
    status: 'granted',
  }),
  'permissions.status': (args) => ({
    permission: permissionOf(args),
    status: 'granted',
  }),
  'media.pick': () => ({ url: MOCK_MEDIA_DATA_URI }),
  'media.capture': () => ({ url: MOCK_MEDIA_DATA_URI }),
};

export function createMockTransport(): MessageTransport {
  const listeners = new Set<(message: WireMessage) => void>();
  const invokeHandlers = mockInvokeHandlers;

  const emit = (message: WireMessage) => {
    queueMicrotask(() => {
      for (const listener of listeners) listener(message);
    });
  };

  return {
    send(type, header, payload) {
      if (type !== MessageType.ENVELOPE || header.type !== 'INVOKE_REQUEST') {
        return;
      }
      const handler = invokeHandlers[header.event];
      if (!handler) {
        emit({
          type: MessageType.ENVELOPE,
          header: {
            type: 'INVOKE_RESPONSE',
            pluginId: header.pluginId,
            event: header.event,
            requestId: header.requestId,
            error: {
              code: ErrorCode.UNSUPPORTED_EVENT,
              message: `Unsupported mock event: ${header.event}`,
            },
          },
          payload: new Uint8Array(0),
        });
        return;
      }
      emit({
        type: MessageType.ENVELOPE,
        header: {
          type: 'INVOKE_RESPONSE',
          pluginId: header.pluginId,
          event: header.event,
          requestId: header.requestId,
          result: handler(header.args, payload),
        },
        payload: new Uint8Array(0),
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
