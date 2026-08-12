# Research: Maestro on WebView apps

**Ticket #3** (part of #1). Question: can Maestro drive `@less/bare` apps — native shell whose whole UI is a WebView/WKWebView loading a loopback-served web app, state via plugin RPC over a loopback WebSocket?

**Verdict: go-with-caveats.** Maestro can see and drive web content inside WebViews on both platforms — it has first-party e2e tests for exactly our shape of app — but webview handling has known gaps/flakiness, needs `extendedWaitUntil` for async state, and multi-device p2p needs two concurrent invocations (fixed in CLI 2.6.0+).

## 1. WebView interaction: YES, but not via a `webview:` selector

- There is **no `webview: true` selector**. `text`/`id` resolve through the **OS accessibility tree** (https://docs.maestro.dev/reference/selectors/core-selectors.md); `css` selectors are for desktop-browser web tests only.
- Android: WebView DOM is not always exposed to a11y. Official workaround is `androidWebViewHierarchy: devtools` in flow frontmatter, which reads the hierarchy via Chrome DevTools (https://docs.maestro.dev/extra-materials/troubleshooting/known-issues.md). This is a first-class, maintained feature (merged issue #2350; Maestro's own e2e `e2e/demo_app/.maestro/webView_chromeDevTools.yaml` asserts rendered text inside a WebView). Caveat: `setWebContentsDebuggingEnabled`-style debuggability required → debug builds only. A v2.6.0 changelog entry fixed "empty Android WebView hierarchies in devtools mode" — a regression since April 2026, i.e. this surface is actively worked on.
- iOS: WKWebView content is exposed through iOS a11y, no special config. Maestro's own e2e (`e2e/workspaces/simple_web_view/webview.yaml`) taps and asserts `text:` on WKWebView content. iOS 26 moved some WebViews to a separate `SafariViewService` process; fixed by merged PR #2872.

## 2. Known limitations (hybrid apps)

- #2064: `assertVisible` on WebView-rendered text fails on `google_apis` (non-Playstore) emulator images and on Maestro Cloud, while working on `google_apis_playstore` and physical devices — WebView parsing is image/API-level sensitive.
- #2293: `id:` matching inside an iOS WKWebView (Flutter + React web app) unrecognized; same id works on Android.
- Maestro's own iOS webview e2e wraps taps in `retry: maxRetries: 2` + `extendedWaitUntil` because "the tap can be silently dropped on a loaded runner" — expect flakiness on loaded CI simulators.

## 3. Async RPC-over-WS state: OK with extended waits

Commands auto-wait while the screen settles; `assertVisible` retries up to a **default ~7 s** timeout. For state arriving late (worklet boot → loopback server → handoff → webapp load → RPC update), use `extendedWaitUntil` with a generous `timeout` (e.g. 90 s; https://docs.maestro.dev/reference/commands-available/extendedwaituntil.md) and `retry` blocks. Assertions wait, they don't poll a sync point — treat initial-load as a race you must wait out.

## 4. Multi-device p2p: two concurrent invocations

- A **single flow runs on one device**. Maestro's sharding (`--shard-all` / `--shard-split`) splits test _files_ across devices — not cross-device coordination (https://docs.maestro.dev/maestro-flows/flow-control-and-logic/specify-and-start-devices.md).
- P2P pattern: run **two `maestro --device <udid> test ...` processes**, one per emulator, synchronized externally (flows can make HTTP calls via `runScript`; httpRequests docs). Historically this hit a driver port-7001 collision (#2556); **CLI ≥ 2.6.0** adds per-device session tracking, cross-process file locking, port-availability checks and `--driver-host-port` so concurrent local runs work (https://maestro.dev/blog/maestro-cli-v2-6-0).

## 5. CI on GitHub Actions: yes, reuses android-emulator-runner

- Install: `MAESTRO_VERSION=<x> curl -Ls https://get.maestro.mobile.dev | bash`, pin a version; requires Java 17+ (https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli.md).
- `maestro test` talks to any adb-visible device, so it **runs inside `reactivecircus/android-emulator-runner`'s `script:`** — proven pattern (facebook/react-native `.github/actions/maestro-android`, Scottish-Tech-Army/Soundscape-Android, pubky/pubky-ring). Maestro's own CI instead boots `emulator @MyAVD &` directly + `xcrun simctl boot` (`.github/workflows/test-e2e.yaml`); either works. iOS needs `macos-*` runners. Maestro Cloud is a separate paid path (one device per run — not for p2p).

## 6. Fallback if it fails

For our WebView shell, the fallbacks are worse: **uiautomator2 / XCUITest** cannot see WebView DOM at all (native a11y only — strictly less than Maestro's devtools read); **Espresso** can, but only for Android and requires `onWebView` + `withElement` matchers (no iOS); **Appium** supports WKWebView via remote-debugging/`safeToSetWebviewEnabled` and works cross-platform, but needs a much heavier driver stack than a one-command CLI. Maestro is the lowest-friction option that already covers Android + iOS.

## Sources

- https://docs.maestro.dev/extra-materials/troubleshooting/known-issues.md
- https://docs.maestro.dev/reference/selectors/core-selectors.md
- https://docs.maestro.dev/reference/commands-available/extendedwaituntil.md
- https://docs.maestro.dev/maestro-flows/flow-control-and-logic/specify-and-start-devices.md
- https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli.md
- https://maestro.dev/blog/maestro-cli-v2-6-0
- https://github.com/mobile-dev-inc/maestro (issues #2350, #2872, #2064, #2293, #2556; e2e flows `webView_chromeDevTools.yaml`, `simple_web_view/webview.yaml`, `.github/workflows/test-e2e.yaml`)
- https://github.com/ReactiveCircus/android-emulator-runner (usage with Maestro: facebook/react-native, Soundscape-Android, pubky-ring)
