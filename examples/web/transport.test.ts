import { describe, expect, it } from 'vite-plus/test';
import { getTransport } from './transport';

describe('getTransport', () => {
  it('throws in production when mock mode is requested (mock must not ship)', async () => {
    await expect(
      getTransport({ VITE_TRANSPORT_MODE: 'mock', PROD: true }),
    ).rejects.toThrow(/production/i);
  });

  it('loads the mock transport in development', async () => {
    const transport = await getTransport({
      VITE_TRANSPORT_MODE: 'mock',
      PROD: false,
    });
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.subscribe).toBe('function');
  });

  it('falls back to the websocket transport when not in mock mode', async () => {
    const transport = await getTransport({
      VITE_TRANSPORT_MODE: 'ws',
      PROD: true,
      DEV: false,
    });
    expect(typeof transport.send).toBe('function');
  });
});
