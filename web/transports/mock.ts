import { MessageType, WireMessage } from '../../core/messages';
import {
  createHealthInvokeHandlers,
  type MockInvokeHandler,
} from './mock-handlers';
import { MessageTransport } from '../websocket-client';

const mockInvokeHandlers: Record<string, MockInvokeHandler> = {
  ...createHealthInvokeHandlers(),
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
        events: ['permissions.requestStorage'],
        runtimes: [],
      },
    ],
  }),
  'permissions.requestStorage': () => ({ granted: true }),
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
              code: 'UNSUPPORTED_EVENT',
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
