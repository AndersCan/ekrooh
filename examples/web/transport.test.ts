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

describe('diagnosticsEnabled (adv-E-1)', () => {
  it('is on in dev or with VITE_BARE_DIAGNOSTICS=true, off otherwise', async () => {
    const { diagnosticsEnabled } = await import('./transport');
    expect(diagnosticsEnabled({ DEV: true })).toBe(true);
    expect(
      diagnosticsEnabled({ VITE_BARE_DIAGNOSTICS: 'true', DEV: false }),
    ).toBe(true);
    expect(diagnosticsEnabled({ VITE_BARE_DIAGNOSTICS: '1', DEV: false })).toBe(
      false,
    );
    expect(diagnosticsEnabled({ PROD: true, DEV: false })).toBe(false);
  });
});
