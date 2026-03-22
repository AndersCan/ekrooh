import { test, expect, _android as android } from '@playwright/test';
let i = 0;
test('app can join swarm and send messages', async () => {
  // Connect to the first available Android device (e.g., the virtual device)
  const [device] = await android.devices();
  if (!device) {
    throw new Error(
      'No Android device found. Make sure your emulator is running.',
    );
  }

  console.log(
    `Testing on device: ${await device.model()} (${await device.serial()})`,
  );

  // Force-stop and launch the application
  const appId = 'to.holepunch.bare.android';
  await device.shell(`am force-stop ${appId}`);
  await device.shell(`am start -n ${appId}/.MainActivity`);

  // Wait for and connect to the WebView
  const webView = await device.webView({ pkg: appId });
  const page = await webView.page();

  // Basic UI check: Topic input and Join button should be visible
  await expect(page.locator('#topic')).toBeVisible();
  const joinButton = page.locator('button:has-text("Join Swarm")');
  await expect(joinButton).toBeVisible();

  // Join the swarm
  await joinButton.click();

  // Verify that the log shows "Joining swarm..."
  const log = page.locator('#log');
  await expect(log).toContainText('info: Joining swarm...');

  // Send a message
  const messageInput = page.locator('#message');
  const message = 'Hello from Playwright E2E - ' + i++;
  await messageInput.fill(message);
  await page.click('button:has-text("Send")');

  // Verify the message appears in the log
  await expect(log).toContainText(`send: ${message}`);
});
