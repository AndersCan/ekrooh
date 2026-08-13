import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Multi-instance harness journeys (ticket #21). Boots the harness worklet
 * (see playwright.config.ts project "harness"), allocates one instance per
 * tab via the management server, injects the per-instance token, and loads the
 * instance's own origin — the app then connects to its instance's loopback
 * WebSocket exactly as it does on-device. The photo sync journey itself
 * ("folder create → invite → join → photo sync") lives in the consumer repo's
 * CI (beta gate A); here the harness's job is asserting per-instance isolation
 * and lifecycle, per the validated design (ticket #5).
 */

const HARNESS_PORT = process.env.HARNESS_PORT ?? '8081';
const SUPERVISOR = `http://127.0.0.1:${HARNESS_PORT}`;

type Instance = { instanceId: string; origin: string; token: string };

async function allocate(): Promise<Instance> {
  const res = await fetch(`${SUPERVISOR}/instances`, { method: 'POST' });
  expect(res.status).toBe(201);
  return (await res.json()) as Instance;
}

async function listInstances(): Promise<string[]> {
  const res = await fetch(`${SUPERVISOR}/instances`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    instances: Array<{ instanceId: string }>;
  };
  return body.instances.map((i) => i.instanceId);
}

async function openTab(browser: Browser, instance: Instance): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript((token) => {
    (window as unknown as { __ekrooh: { token?: string } }).__ekrooh = {
      token,
    };
  }, instance.token);
  await page.goto(instance.origin);
  return page;
}

async function expectConnected(page: Page) {
  await expect(
    page.getByRole('heading', { name: 'Plugin Health Checks' }),
  ).toBeVisible();
  await expect(page.getByText(/Discovery v1:/)).toBeVisible({
    timeout: 15_000,
  });
}

test('two tabs get isolated instances and both roundtrip health', async ({
  browser,
}) => {
  const a = await allocate();
  const b = await allocate();
  expect(a.origin).not.toBe(b.origin);

  const pageA = await openTab(browser, a);
  await expectConnected(pageA);
  await pageA.getByRole('button', { name: 'Roundtrip' }).click();
  await expect(pageA.getByText(/ROUNDTRIP ok: true/)).toBeVisible();

  const pageB = await openTab(browser, b);
  await expectConnected(pageB);
  await pageB.getByRole('button', { name: 'Roundtrip' }).click();
  await expect(pageB.getByText(/ROUNDTRIP ok: true/)).toBeVisible();

  // The supervisor tracks both instances independently.
  await expect.poll(() => listInstances()).toContain(a.instanceId);
  expect(await listInstances()).toContain(b.instanceId);

  await pageA.close();
  await pageB.close();
});

test('reload reconnects to the same instance (context survives socket close)', async ({
  browser,
}) => {
  const instance = await allocate();
  const page = await openTab(browser, instance);
  await expectConnected(page);

  await page.reload();
  // A fresh socket to the same context; the instance was not reaped.
  await expectConnected(page);
  expect(await listInstances()).toContain(instance.instanceId);

  await page.close();
});

test('destroying an instance does not disturb another', async ({ browser }) => {
  const a = await allocate();
  const b = await allocate();

  const pageB = await openTab(browser, b);
  await expectConnected(pageB);

  const del = await fetch(`${SUPERVISOR}/instances/${a.instanceId}`, {
    method: 'DELETE',
  });
  expect(del.status).toBe(200);

  const listed = await listInstances();
  expect(listed).not.toContain(a.instanceId);
  expect(listed).toContain(b.instanceId);

  // a's loopback origin is gone (server closed) — connection refused.
  let reachable = true;
  try {
    await fetch(a.origin);
  } catch {
    reachable = false;
  }
  expect(reachable).toBe(false);

  // b keeps serving its page and roundtrips health untouched.
  await pageB.getByRole('button', { name: 'Roundtrip' }).click();
  await expect(pageB.getByText(/ROUNDTRIP ok: true/)).toBeVisible();

  await pageB.close();
});
