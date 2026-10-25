# Maestro on WebView apps

Ticket #3 (part of #1). Question: can Maestro drive `@ekrooh/bare` apps, whose
whole UI is a WebView/WKWebView loading a loopback-served web app with plugin RPC
over a loopback WebSocket?

**Verdict: go, with caveats.** Maestro can see and drive WebView content on both
platforms. Expect flakiness, use `extendedWaitUntil` for async state, and run two
concurrent invocations for multi-device p2p (CLI 2.6.0+).

## 1. WebView interaction

- No `webview: true` selector. `text`/`id` resolve through the OS accessibility
  tree. `css` selectors are desktop-browser only.
- Android: WebView DOM is not always in the a11y tree. Use
  `androidWebViewHierarchy: devtools` in flow frontmatter (reads via Chrome
  DevTools). Needs a debuggable build. CLI 2.6.0 fixed empty hierarchies in this mode.
  Maestro's own e2e (`e2e/demo_app/.maestro/webView_chromeDevTools.yaml`) asserts
  WebView text this way.
- iOS: WKWebView content is exposed to a11y with no config. Maestro's e2e
  (`e2e/workspaces/simple_web_view/webview.yaml`) taps and asserts it. iOS 26 moved
  some WebViews to `SafariViewService`; fixed by PR #2872.

## 2. Known limitations

- #2064: `assertVisible` on WebView text fails on `google_apis` (non-Play) emulator
  images and Maestro Cloud. Works on `google_apis_playstore` and devices.
- #2293: `id:` inside an iOS WKWebView not matched (Flutter + React). Works on Android.
- Maestro's iOS webview e2e wraps taps in `retry: maxRetries: 2` +
  `extendedWaitUntil` because taps are silently dropped on loaded runners.

## 3. Async RPC-over-WS state

Assertions retry for about 7 s by default. Worklet boot, loopback server, handoff,
webapp load and RPC update are a race. Use `extendedWaitUntil` with
`timeout` around 90 s, plus `retry` blocks. Assertions wait; they do not sync.

## 4. Multi-device p2p

- One flow runs on one device. `--shard-all`/`--shard-split` shard files, not
  devices.
- Run two `maestro --device <udid> test ...` processes and sync them externally
  (for example via HTTP calls in `runScript`).
- Driver port 7001 collisions (#2556) are fixed in CLI >= 2.6.0 (per-device session
  tracking, file locking, port checks, `--driver-host-port`).

## 5. CI on GitHub Actions

- Install a pinned version: `MAESTRO_VERSION=<x> curl -Ls https://get.maestro.mobile.dev | bash`.
  Needs Java 17+.
- Run `maestro test` inside `reactivecircus/android-emulator-runner`'s `script:`.
  Proven in facebook/react-native, Soundscape-Android and pubky-ring. Maestro's own CI
  boots `emulator`/`simctl` directly (`.github/workflows/test-e2e.yaml`).
- iOS needs `macos-*` runners. Maestro Cloud is a separate paid path, one device
  per run, unsuited to p2p.

## 6. Fallbacks

- uiautomator2 and XCUITest cannot see WebView DOM.
- Espresso sees it on Android only (`onWebView` + `withElement`).
- Appium supports WKWebView but needs a much heavier driver stack.

Maestro is the lowest-friction option covering Android and iOS.

## Sources

- https://docs.maestro.dev/extra-materials/troubleshooting/known-issues.md
- https://docs.maestro.dev/reference/selectors/core-selectors.md
- https://docs.maestro.dev/reference/commands-available/extendedwaituntil.md
- https://docs.maestro.dev/maestro-flows/flow-control-and-logic/specify-and-start-devices.md
- https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli.md
- https://maestro.dev/blog/maestro-cli-v2-6-0
- https://github.com/mobile-dev-inc/maestro (issues #2350, #2872, #2064, #2293, #2556)
- https://github.com/ReactiveCircus/android-emulator-runner
