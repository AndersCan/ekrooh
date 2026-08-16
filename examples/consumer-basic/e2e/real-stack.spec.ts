import { expect, test } from '@playwright/test';

/**
 * Real-stack e2e (docs hosts/testing.mdx pattern): the page is served by the
 * worklet's own loopback server (same-origin WebSocket, exactly like on
 * device). Asserts the consumer plugin's full roundtrip — one invoke
 * (`basic.ping`) whose handler also pushes one backend → web dispatch
 * (`basic.beep`) — plus zero console errors.
 */
test('ping invoke + backend push roundtrip over the real stack', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Consumer basic' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ping' })).toBeVisible({
    timeout: 15_000,
  });

  // Invoke roundtrip.
  await page.getByRole('button', { name: 'Ping' }).click();
  await expect(page.getByText(/PING ok: hello consumer/)).toBeVisible({
    timeout: 10_000,
  });

  // The ping handler also pushed a backend → web beep.
  await expect(
    page.getByText('Beeps received: 1', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Last beep: #1', { exact: true })).toBeVisible();

  // Second ping: the counter advanced, proving the push arrived per invoke.
  await page.getByRole('button', { name: 'Ping' }).click();
  await expect(page.getByText(/PING ok: hello consumer/)).toBeVisible();
  await expect(
    page.getByText('Beeps received: 2', { exact: true }),
  ).toBeVisible();

  expect(errors).toEqual([]);
});
