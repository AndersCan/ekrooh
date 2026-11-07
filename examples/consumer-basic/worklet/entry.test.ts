import { expect, it, vi } from 'vite-plus/test';

const close = vi.fn();
const register = vi.fn();
vi.mock('@ekrooh/bare/runtime', () => ({
  createWorkletRuntime: () => ({
    server: {},
    protocol: {},
    pluginRegistry: { register },
    start: () => Promise.reject(new Error('port in use')),
    close,
  }),
  resolveWorkletConfig: () => ({}),
  createLoopbackPush: () => () => true,
}));

it('logs and closes the runtime when start() rejects (adv-B-8)', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    await import('./entry');
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(String(error.mock.calls[0]?.[0])).toContain('port in use');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(1);
  } finally {
    process.off('unhandledRejection', unhandled);
    error.mockRestore();
  }
});
