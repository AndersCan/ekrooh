import { expect, test } from '@playwright/test';

test('health plugin checks pass in mock runtime', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Plugin Health Checks' }),
  ).toBeVisible();
  await expect(page.getByText(/Discovery v1:/)).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole('button', { name: 'Ping' }).click();
  await expect(page.getByText(/PING ok:/)).toBeVisible();

  await page.getByRole('button', { name: 'Payload Echo' }).click();
  await expect(page.getByText(/PAYLOAD ok: sample \(13 bytes\)/)).toBeVisible();

  await page.getByRole('button', { name: 'Roundtrip' }).click();
  await expect(page.getByText(/ROUNDTRIP ok: true/)).toBeVisible();

  await page.getByRole('button', { name: 'Storage permission' }).click();
  await expect(
    page.getByText(/Storage permission: granted=true/),
  ).toBeVisible();
});
