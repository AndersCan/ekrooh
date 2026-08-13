# iOS Host — Handoff

> **Status: superseded.** This brief describes the Phase 1 design (WKWebView
> bridge over `WKScriptMessageHandler`). Phase 2 replaced it with the unified
> loopback server + cookie auth: the host injects `window.__lessBareToken`,
> reads the worklet's `handoff.json`, and loads `http://127.0.0.1:<port>/index.html`.
> The implemented host is `examples/ios-app/app/BareRuntime.swift` + `ios/`.
> Keep this file as the historical brief only.

Build the **iOS shell/host for `@less/bare`**. This doc is the operating brief;
read it alongside `vision.md` (the contract), `AGENTS.md` (commands/ownership),
and `core/messages/readme.md` (wire protocol). The **Kotlin host is the
reference implementation** — mirror it in Swift, don't redesign it.

Per `vision.md`, iOS was **contract-only at the time**: it had to satisfy the same binary
wire protocol and plugin contracts. Distribution is "decided then, on the same
release tag." The runtime is `bare-ios` (`holepunchto/bare-ios`, cloned as a
reference) + `bare-kit-swift`.

---

## 1. What you're building

A Swift host library (like `android/`) that:

1. Runs the same backend worklet bundle (`core/main.core.bundle`, produced by
   `npm run build:core`) in a `Worklet`, on the same `IPC` byte channel.
2. Speaks the **identical wire protocol** end to end — a Swift `BareProtocol`
   mirror of `android/.../BareProtocol.kt`.
3. Handles host-side messages (`HOST_CAPABILITIES_QUERY`,
   `HOST_INVOKE_REQUEST`) and **relays every other envelope to the web layer**
   as raw bytes — mirroring `HostIpcCoordinator.kt` exactly.
4. Registers host plugin handlers (`core.permissions` stub) — mirroring
   `HostPluginRegistry.kt` + `DefaultHostPlugins.kt`.
5. Bridges the web layer (WKWebView) to the worklet IPC. **This is the one part
   that cannot be copied from Android** (no `WebMessagePort` on iOS) — see §5.

Reference runtime repos:

- `holepunchto/bare-ios` — example iOS app consuming the runtime. Shows
  `BareKit.xcframework` prebuilt + `bare-kit-swift` wiring + xcodegen.
- `holepunchto/bare-kit-swift` — the Swift bindings: `Worklet`, `IPC`.

Do **not** use `bare-rpc-swift`/`HRPC` framing from the bare-ios example — our
protocol defines its own envelope; use **raw IPC** (`IPC` async sequence +
`write(data:)`), exactly like the Kotlin host uses raw `IPC.read()/write()`.

---

## 2. The wire contract to implement (Swift)

Source of truth: `core/messages/wire-codec.ts`, `core/messages/constants.ts`,
`core/messages/readme.md`. Kotlin mirror: `BareProtocol.kt`, `ErrorCodes.kt`.

### Envelope (identical bytes)

```
[version:1B][type:1B][headerLen:2B BE][header: UTF-8 JSON][payload: raw bytes]
```

- `VERSION = 1`, `MessageType.ENVELOPE = 1`.
- Header length must not exceed `MAX_HEADER_BYTES = 0xFFFF`; total frame must
  not exceed `MAX_FRAME_BYTES = 16 MiB`. Oversize → throw/reject with
  `FRAME_TOO_LARGE` (never silently truncate — see `BareProtocol.kt`).
- Unknown header fields must **pass through** untouched (forward-compat).

### Header types

`DISPATCH`, `INVOKE_REQUEST`, `INVOKE_RESPONSE` (plugin) and
`HOST_CAPABILITIES_QUERY`, `HOST_CAPABILITIES_RESPONSE`,
`HOST_INVOKE_REQUEST`, `HOST_INVOKE_RESPONSE` (host). All invoke responses echo
`requestId`. Result shape is the `Either` tuple over the wire:
success `[null, result]`, failure `[error, null]` with
`error = { code, message }`.

### Error codes (keep `ErrorCodes.swift` in sync — add an XCTest parity check)

`UNSUPPORTED_CAPABILITY`, `UNSUPPORTED_EVENT`, `HOST_ERROR`,
`TRANSPORT_ERROR`, `PLUGIN_ERROR`, `INVALID_RESPONSE`, `FRAME_TOO_LARGE`,
`FRAME_INVALID`, `TIMEOUT`.

### Capability rows

`HOST_CAPABILITIES_RESPONSE` carries rows:
`{ pluginId, capabilities: string[], events: string[], runtimes: ["ios"] }`.

---

## 3. Runtime dependencies

- `Worklet` / `IPC` from **`bare-kit-swift`** (SPM package `BareKit`).
- **`BareKit.xcframework`** prebuilt — the iOS equivalent of Android's
  `prebuilds/android/bare-kit`. It ships in the same `holepunchto/bare-kit`
  GitHub release, inside `prebuilds.zip` under `ios/BareKit.xcframework`.
- **Pin to the same bare-kit release the Android prebuilds use**: currently
  `v2.3.0` (`scripts/fetch-prebuilds.mjs`). Extend that script (or add
  `scripts/fetch-prebuilds-ios.mjs`) to also unpack `ios/*` into `prebuilds/ios/`
  (gitignored). The bare-ios README shows the exact
  `gh release download ... --pattern prebuilds.zip` flow.

Swift API surface (from `bare-kit-swift`):

```swift
let worklet = Worklet(configuration: Worklet.Configuration(memoryLimit: 128 << 20))
worklet.start(name: "main.core", ofType: "bundle", inBundle: .main) // or start(filename:source:)
let ipc = IPC(worklet: worklet)
try await ipc.write(data: frameData)          // host → worklet
for try await chunk in ipc { /* worklet → host */ }
worklet.terminate(); ipc.close()
```

---

## 4. Architecture — mirror the Kotlin host

| Kotlin (`android/src/main/.../bare/android/`) | Swift equivalent                | Notes                                                                            |
| --------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| `BareProtocol.kt`                             | `BareProtocol.swift`            | envelope encode/decode + `buildErrorResponse`                                    |
| `ErrorCodes.kt`                               | `ErrorCodes.swift`              | + parity XCTest                                                                  |
| `HostIpcCoordinator.kt`                       | `HostIpcCoordinator.swift`      | read loop; handle host messages; **relay other envelopes as the original bytes** |
| `HostPluginRegistry.kt`                       | `HostPluginRegistry.swift`      | keyed handlers, `UNSUPPORTED_CAPABILITY` on miss, capability rows                |
| `DefaultHostPlugins.kt`                       | `DefaultHostPlugins.swift`      | register `core.permissions.permissions.request` / `permissions.status` handlers  |
| `BarePortMessenger.kt`                        | `BareWebViewBridge.swift`       | **iOS-specific**, see §5                                                         |
| `MainActivity.kt`                             | app entry (`AppDelegate`/scene) | Worklet lifecycle, bridge wiring, WKWebView hosting                              |

Key behavior to copy from `HostIpcCoordinator.kt`:

1. `for try await chunk in ipc` loop (or `read()` loop).
2. Copy the raw bytes, parse the header to decide.
3. `HOST_CAPABILITIES_QUERY` → reply with host registry rows.
4. `HOST_INVOKE_REQUEST` → dispatch to registry, reply Ok/Fail as
   `HOST_INVOKE_RESPONSE`.
5. **Anything else → forward the original bytes to the web layer** (no
   re-parse, no re-serialization).
6. Wrap the loop in error handling that **logs**, never silently swallows.

---

## 5. The iOS WebView bridge (the real design decision)

Android uses `WebMessagePort` (raw binary on API 34+, base64 strings below).
**WKWebView has no message ports.** Use the standard WKWebView mechanisms:

- **Web → native**: `WKScriptMessageHandler`. The page calls
  `window.webkit.messageHandlers.bareHost.postMessage(<string>)`. The payload
  must be a **base64-encoded frame** (WKScriptMessageHandler only supports
  plist types — no `ArrayBuffer`/raw bytes).
- **Native → web**: inject a callback and
  `webView.evaluateJavaScript("window.onBareMessage('<base64>')")`. Or use a
  `WKUserScript` to define `window.onBareMessage`.
- The **frame bytes are identical** to every other transport; only the carrier
  is base64. This mirrors Android's API<34 fallback exactly.

### JS transport (web side)

`web/transports/bootstrap-bridge.ts` is **port-based** (Android). iOS needs a
second mode or a sibling transport (e.g. `bootstrap-bridge-wkwebview.ts`)
implementing the same `MessageTransport` interface
(`send(type, header, payload)` + `subscribe`):

- Detect: `window.webkit?.messageHandlers?.bareHost` present.
- Out: `window.webkit.messageHandlers.bareHost.postMessage(base64(frame))`.
- In: `window.onBareMessage = (base64) => { decode → listeners }`.
- Encode/decode with the **same `MessageProtocol`** so wire bytes are
  identical.
- Update `examples/web/transport.ts` selection: mock → `VITE_TRANSPORT_MODE`,
  then `window.BareShell` (Android), then `window.webkit?.messageHandlers?.bareHost`
  (iOS), else WebSocket.

### Host plugin delegation works unchanged

The worklet delegates `core.permissions` invokes down the IPC as
`HOST_INVOKE_REQUEST`; the Swift `HostPluginRegistry` answers — no JS changes
needed. Same for discovery (`core.discovery.list` merges host rows via
`HOST_CAPABILITIES_QUERY`).

---

## 6. Reference app

Mirror `examples/android-app` with `examples/ios-app`:

- Consume the Swift host + the same built web app
  (`npm run build:web` output, currently written into
  `examples/android-app/src/main/assets/`). For iOS, copy those assets into the
  app bundle and serve with `WKWebView.loadFileURL(...)` (or a custom
  `URLProtocol`) — the equivalent of `WebViewAssetLoader`.
- Wire the full lifecycle in the scene/app delegate: `Worklet.start` with the
  packed `main.core.bundle` (`npm run build:core` → `core/main.core.gen.js`
  packed via `bare-pack --preset ios`, see bare-ios's scheme pre-actions),
  `IPC`, read loop, bridge attach after `didFinish navigation`.
- The reference app doubles as the integration harness — it must show the
  health checks page with `Discovery v1: 3 plugin(s) — core.health,
core.discovery, core.permissions` and respond to Ping / Payload Echo /
  Roundtrip / Storage permission, exactly like on Android.

---

## 7. Tests (mirror the Kotlin JUnit suite as XCTest)

- `BareProtocolTest` → round-trip, oversized header/frame rejection,
  `buildErrorResponse` shape.
- `HostPluginRegistryTest` → dispatch Ok/Fail, `UNSUPPORTED_CAPABILITY` on
  missing handler, capability rows JSON.
- `ErrorCodesParityTest` → Swift constants match the canonical strings.
- Run via `xcodebuild test` on the simulator; JS gates (`vp check`, `vp test`)
  must stay green and unchanged.

## 8. Distribution (decided this milestone, per vision.md)

- Ship the Swift host source in this repo (`ios/`, mirroring `android/`) so it
  rides the same single-version release tag.
- Package as an SPM package depending on `bare-kit-swift` + bundling the
  `BareKit.xcframework` (the SPM equivalent of the AAR's `libs/` packaging —
  consumers get the runtime without a separate prebuilds download).
- Confirm the bare-kit **minimum iOS version** (bare-ios example uses
  deploymentTarget 18.4; pin the host's minimum to whatever `bare-kit` requires)
  and the memory/assets defaults.
- Note in `RELEASING.md` and `vision.md` once decided. iOS artifacts publish on
  the same `vX.Y.Z` tag as npm + AAR.

---

## 9. Task checklist

1. [ ] Fetch iOS prebuilds (`ios/BareKit.xcframework`) for bare-kit `v2.3.0`.
2. [ ] Scaffold `ios/` Swift package (host lib) + `examples/ios-app`.
3. [ ] `BareProtocol.swift` + `ErrorCodes.swift` + XCTest parity/round-trips.
4. [ ] `HostPluginRegistry.swift` + `DefaultHostPlugins.swift` + XCTest.
5. [ ] `HostIpcCoordinator.swift` (raw-bytes relay) — mirror Kotlin exactly.
6. [ ] `BareWebViewBridge.swift` (WKWebView, base64 frames) + JS transport
       (iOS mode in `bootstrap-bridge.ts` or a sibling).
7. [ ] Worklet/IPC lifecycle in the app entry; serve the web app in WKWebView.
8. [ ] `examples/ios-app` shows the full health-check page end to end.
9. [ ] Gates: `vp check`, `vp test` (unchanged), `xcodebuild test`, plus the
       JS+e2e suite untouched.
10. [ ] Decide distribution (SPM host package + framework bundling); update
        `vision.md`/`RELEASING.md`; ship source on the next tag.

## 10. Open questions for the human

- Minimum iOS deployment target (match bare-kit's floor vs bare-ios's 18.4).
- Distribution: publish the Swift host as an SPM package on the tag, or ship
  source-only like `android/` until a consumer appears.
- Whether to fold the iOS transport into `bootstrap-bridge.ts` (shared encode/
  decode, two carriers) or keep a separate transport file.
