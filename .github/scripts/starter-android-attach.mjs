/**
 * One attach try for starter-android-reload.mjs: Playwright's view of the
 * debug app's WebView. Split out so a test can drive it with stub objects.
 */

// Rejects when a call hangs.
export function within(ms, promise) {
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

/**
 * Returns { page } on success, else { error }; resetAttach returns '' or the
 * restart error. Playwright keeps a hung webView().page() attempt and
 * returns it on every later call, so only a failed page() restarts the app.
 * A webView() that times out is the normal "socket not listed yet" state right
 * after `am start`: it retries on the same device and never restarts the app.
 */
export async function attachTry({ android, pkg, attemptMs, resetAttach }) {
  let device;
  try {
    [device] = await within(attemptMs, android.devices());
  } catch (error) {
    return { error: String(error.message).split('\n')[0] };
  }
  if (!device) return { error: 'Playwright sees no device' };
  let webView;
  try {
    webView = await within(
      attemptMs,
      device.webView({ pkg }, { timeout: 2000 }),
    );
  } catch (error) {
    return { error: String(error.message).split('\n')[0] };
  }
  try {
    return { page: await within(attemptMs, webView.page()) };
  } catch (error) {
    // A new app process opens a new devtools socket and so a new webview
    // object; closing the device makes the next devices() build a fresh one.
    const message = String(error.message).split('\n')[0];
    const restartError = await resetAttach(device);
    return {
      error: restartError
        ? `${message}; restart failed: ${restartError}`
        : message,
    };
  }
}
