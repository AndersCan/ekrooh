<p align="center">
  <img src="apps/docs/src/assets/logo.svg" width="112" height="112" alt="Ekrooh logo: four rounded windows that each hold a quarter of one amber circle">
</p>

<h1 align="center">Ekrooh</h1>

<h3 align="center">The boring bootstrap for cross-platform apps</h3>

<p align="center">
  <strong>One soul, many platforms.</strong> Write your app once as a web app and run it on Android, iOS, the web, and desktop.
</p>

<p align="center">
  <a href="https://github.com/AndersCan/ekrooh/actions/workflows/test.yml"><img src="https://github.com/AndersCan/ekrooh/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/AndersCan/ekrooh/releases/latest"><img src="https://img.shields.io/github/v/release/AndersCan/ekrooh" alt="Release"></a>
</p>

<p align="center">
  <a href="https://anderscan.github.io/ekrooh"><strong>Documentation</strong></a> ·
  <a href="https://anderscan.github.io/ekrooh/getting-started/start-here/">Start here</a> ·
  <a href="vision.md">Vision</a>
</p>

---

Ekrooh (`@ekrooh/bare`, from _ek rooh_, "one soul") starts a backend on the
device, connects your web UI to it, and gives the UI native features like the
camera and the file picker. It runs on the
[Bare runtime](https://github.com/holepunchto/bare), keeps its contracts
stable, and behaves the same on every platform.

## What you get

- **One UI everywhere.** You write a normal web app. The same bundle runs in a
  browser and inside the native app on each platform.
- **Native features as plugins.** Camera, files, and permissions are plugins
  you call the same way on every platform. On a platform whose host lacks a
  feature, the call returns an `UNSUPPORTED_EVENT` error.
- **Ready-made native hosts.** An Android library on Maven Central and an iOS
  Swift package start your app's backend and connect it to the UI.
- **Private by default.** The backend on the device requires a per-session
  token on every request, so other apps and websites can't call it.
- **Peer-to-peer ready.** Bare comes from the Holepunch p2p ecosystem, so your
  app can sync directly between devices.
- **A working reference app** for web, Android, iOS, and desktop to copy from.

Ekrooh is not a UI framework or a build tool. Bring your own UI library and
your existing Vite app.

## Platforms

| Android     | iOS         | Web         | Desktop                  |
| ----------- | ----------- | ----------- | ------------------------ |
| first-class | first-class | first-class | reference (macOS, Linux) |

Details are in the [support matrix](https://anderscan.github.io/ekrooh/getting-started/architecture/#support-matrix).

## Get started

```bash
npm install @ekrooh/bare
```

Then follow [Start here](https://anderscan.github.io/ekrooh/getting-started/start-here/),
or go straight to the [web quickstart](https://anderscan.github.io/ekrooh/getting-started/web-quickstart/)
or the [end-to-end quickstart](https://anderscan.github.io/ekrooh/consumers/end-to-end/)
for Android and iOS.

## Learn more

The [documentation site](https://anderscan.github.io/ekrooh) has the technical
details:

- **How it works:** [introduction](https://anderscan.github.io/ekrooh/getting-started/introduction/)
  and [architecture](https://anderscan.github.io/ekrooh/getting-started/architecture/)
- **Core concepts:** [wire protocol](https://anderscan.github.io/ekrooh/core-concepts/wire-protocol/),
  [plugins](https://anderscan.github.io/ekrooh/core-concepts/plugin-kernel/),
  [loopback server and auth](https://anderscan.github.io/ekrooh/core-concepts/loopback-server-auth/),
  [media](https://anderscan.github.io/ekrooh/guides/media/)
- **Native hosts:** [Android](https://anderscan.github.io/ekrooh/hosts/android/),
  [iOS](https://anderscan.github.io/ekrooh/hosts/ios/),
  [using the Android AAR](https://anderscan.github.io/ekrooh/consumers/android-aar/)
- **Desktop:** the [desktop reference app](https://github.com/AndersCan/ekrooh/tree/main/examples/desktop-app)
- **Testing:** [how Ekrooh is tested](https://anderscan.github.io/ekrooh/hosts/testing/)

About the project:

- [`vision.md`](vision.md): what Ekrooh is and is not.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to contribute.
- [`SECURITY.md`](SECURITY.md): how to report a vulnerability.
- [`CHANGELOG.md`](CHANGELOG.md) and [`RELEASING.md`](RELEASING.md): releases.
- [`docs/`](docs/): internal decision records (ADRs) and agent notes.

<details>
<summary><strong>Developing Ekrooh</strong></summary>

[`AGENTS.md`](AGENTS.md) is the operating manual and has the
[full command list](AGENTS.md#canonical-commands).
[`CONTRIBUTING.md`](CONTRIBUTING.md) has the change workflow and the gate CI
runs.

### Setup

```bash
vp install
npm run playwright:install   # once, for e2e
npm run prebuilds            # once, for Android and iOS (Node + unzip, no token)
```

### Common commands

| Command                  | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `npm run build:pkg`      | Compile the package to `dist/` (run first)         |
| `vp check`               | Format, lint, type-check                           |
| `vp test`                | Unit tests                                         |
| `npm run test`           | Unit + Playwright e2e                              |
| `npm run dev`            | Vite dev server + Bare backend (watch restart)     |
| `npm run dev:mock`       | Vite with mock transport                           |
| `npm run build:core`     | Bundle `core/main.core.ts` (esbuild)               |
| `npm run build:web`      | Build `examples/web` into the Android app's assets |
| `npm run build:ios`      | iOS inputs (addons, bundle, web assets, xcodegen)  |
| `npm run docs:dev`       | Run the docs site locally                          |
| `npm run docs:check`     | Docs gates (after `build:pkg`)                     |
| `npm run smoke:loopback` | Smoke-test the loopback server under `bare`        |

### Android build

Needs the Android SDK (`local.properties` with `sdk.dir=...`) and Bare Kit
prebuilds.

```bash
vp install
npm run prebuilds
npm run build       # core bundle + web assets
./gradlew :examples:android-app:assembleDebug
```

`./gradlew build` also runs the host library's JUnit tests.

### iOS build

Needs Xcode, Bare Kit prebuilds, and `xcodegen`.

```bash
vp install
npm run prebuilds   # also fetches prebuilds/ios/BareKit.xcframework
npm run build:ios
npm run test:ios
```

### Notes

- Treat `examples/android-app/src/main/assets/` as build output. Vite clears
  hashed `assets/main-*.{js,css}` before rebuilding.
- The repository layout is described in the
  [introduction](https://anderscan.github.io/ekrooh/getting-started/introduction/#repository-layout).

</details>
