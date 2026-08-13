import { expect, test } from '@playwright/test';
import { MessageProtocol, MessageType } from '@ekrooh/bare/core';
import type { RuntimeTarget } from '@ekrooh/bare/core';

test('protocol round-trip preserves type/header/payload', () => {
  const protocol = new MessageProtocol();
  const payload = new Uint8Array([1, 2, 3, 4]);
  const requestId = 'req-1';

  const encoded = protocol.encode(
    MessageType.ENVELOPE,
    {
      type: 'INVOKE_RESPONSE',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId,
    },
    payload,
  );
  const decoded = protocol.decode(encoded);

  expect(decoded.type).toBe(MessageType.ENVELOPE);
  expect(decoded.header).toEqual({
    type: 'INVOKE_RESPONSE',
    pluginId: 'core.health',
    event: 'health.ping',
    requestId,
  });
  expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4]);
});

test('protocol rejects unsupported version', () => {
  const protocol = new MessageProtocol();
  const encoded = protocol.encode(
    MessageType.ENVELOPE,
    {
      type: 'DISPATCH',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'req-2',
    },
    null,
  );

  encoded[0] = 99;
  expect(() => protocol.decode(encoded)).toThrow(/Unsupported version/);
});

test('protocol rejects unknown message type by default', () => {
  const protocol = new MessageProtocol();
  const encoded = protocol.encode(
    MessageType.ENVELOPE,
    { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
    null,
  );

  encoded[1] = 250;
  expect(() => protocol.decode(encoded)).toThrow(/Unsupported message type/);
});

test('protocol rejects non-plugin header types', () => {
  const protocol = new MessageProtocol();
  const encoded = protocol.encode(
    MessageType.ENVELOPE,
    { type: 'SET_HOME' } as never,
    null,
  );
  expect(() => protocol.decode(encoded)).toThrow(/Unsupported header type/);
});

test('protocol round-trip host capabilities response header', () => {
  const protocol = new MessageProtocol();
  const header = {
    type: 'HOST_CAPABILITIES_RESPONSE' as const,
    requestId: 'host-cap-1',
    capabilities: [
      {
        pluginId: 'core.permissions',
        capabilities: [] as string[],
        events: ['permissions.requestStorage'],
        runtimes: ['android'] as RuntimeTarget[],
      },
    ],
  };
  const encoded = protocol.encode(MessageType.ENVELOPE, header, null);
  const decoded = protocol.decode(encoded);
  expect(decoded.header).toEqual({
    type: 'HOST_CAPABILITIES_RESPONSE',
    requestId: 'host-cap-1',
    capabilities: [
      {
        pluginId: 'core.permissions',
        capabilities: [],
        events: ['permissions.requestStorage'],
        runtimes: ['android'],
      },
    ],
  });
});
