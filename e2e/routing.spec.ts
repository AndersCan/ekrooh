import { expect, test } from '@playwright/test';

test('in-app navigation between home and demo route', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Plugin Health Checks' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Demo route' }).click();
  await expect(page).toHaveURL(/\/demo\/?$/);
  await expect(page.getByRole('heading', { name: 'Demo route' })).toBeVisible();
  await expect(page.getByText(/Path:/)).toBeVisible();

  await page.getByRole('link', { name: 'Health checks' }).click();
  // page.url() is a synchronous string — assert it directly (awaiting it is
  // a type error under the lint rules and pointless).
  expect(page.url()).not.toContain('/demo');
  await expect(
    page.getByRole('heading', { name: 'Plugin Health Checks' }),
  ).toBeVisible();
});

test('direct load of /demo shows demo page', async ({ page }) => {
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: 'Demo route' })).toBeVisible();
});
