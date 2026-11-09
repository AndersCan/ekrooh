import { describe, expect, it } from 'vite-plus/test';

// The attach try of the Android reload check, driven with stub Playwright
// objects. The module is plain JS; a non-literal import keeps tsc quiet.
const modUrl = new URL(
  '../.github/scripts/starter-android-attach.mjs',
  import.meta.url,
).href;
const { attachTry } = await import(modUrl);

const never = () => new Promise(() => {});

function stub(webView: () => Promise<unknown>, page: () => Promise<unknown>) {
  const resets: unknown[] = [];
  const device = { webView, close: async () => {} };
  const android = { devices: async () => [device] };
  return {
    resets,
    run: () =>
      attachTry({
        android,
        pkg: 'p',
        attemptMs: 30,
        resetAttach: async (d: unknown) => {
          resets.push(d);
        },
      }),
    page,
    device,
    webViewObj: { page },
  };
}

describe('attachTry', () => {
  it('returns the page', async () => {
    const s = stub(
      async () => s.webViewObj,
      async () => 'PAGE',
    );
    expect(await s.run()).toEqual({ page: 'PAGE' });
    expect(s.resets).toEqual([]);
  });

  it('retries without restarting the app while the socket is not listed', async () => {
    const s = stub(never, async () => 'PAGE');
    const got = await s.run();
    expect(got.page).toBeUndefined();
    expect(got.reset).toBeUndefined();
    expect(got.error).toMatch(/no answer/);
    expect(s.resets).toEqual([]);
  });

  it('restarts the app when page() hangs', async () => {
    const s = stub(async () => s.webViewObj, never);
    const got = await s.run();
    expect(got.reset).toBe(true);
    expect(s.resets).toEqual([s.device]);
  });

  it('reports a missing device and a hung devices() without restarting', async () => {
    const resets: unknown[] = [];
    const resetAttach = async (d: unknown) => {
      resets.push(d);
    };
    expect(
      await attachTry({
        android: { devices: async () => [] },
        pkg: 'p',
        attemptMs: 30,
        resetAttach,
      }),
    ).toEqual({ error: 'Playwright sees no device' });
    const hung = await attachTry({
      android: { devices: never },
      pkg: 'p',
      attemptMs: 30,
      resetAttach,
    });
    expect(hung.error).toMatch(/no answer/);
    expect(resets).toEqual([]);
  });
});
