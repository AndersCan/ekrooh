<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Project Operating Manual

This repo is **`@less/bare`** — the boring bootstrap for cross-platform apps on
the Bare runtime. **Read `vision.md` first.** It defines what this project is
and is not, and it wins over any code-level decision.

## Canonical commands

Run from the repo root. The gate for every change is `vp check` + `vp test`.

| Command                                         | Meaning                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `vp install`                                    | Install workspace dependencies                                          |
| `vp check`                                      | Format (`oxfmt`) + lint (`oxlint`) + type-check (`tsc`)                 |
| `npm run typecheck`                             | `tsc --noEmit` only                                                     |
| `vp test`                                       | Unit tests (vitest, `**/*.test.ts`)                                     |
| `npm run test:e2e:web`                          | Playwright e2e (needs `npm run playwright:install` first)               |
| `npm run test`                                  | Unit + e2e                                                              |
| `npm run build:core`                            | Bundle `core/main.core.ts` for the Bare worklet (esbuild)               |
| `npm run build:web`                             | Build the reference web app into `examples/android-app/src/main/assets` |
| `npm run dev`                                   | Vite dev server + Bare backend (watch + restart)                        |
| `./gradlew :examples:android-app:assembleDebug` | Build the Android APK                                                   |
| `npm run prebuilds`                             | Fetch Bare Kit prebuilds (Android + iOS) for the pinned release         |
| `npm run build:ios`                             | Build iOS reference app inputs (`bare-link`, `bare-pack`, web assets)   |
| `npm run test:ios`                              | Run the Swift host XCTest + UI tests on the iOS simulator               |

Notes:

- The web app lives at `examples/web`; Vite+ commands for it use
  `vp -C examples/web dev|build`. The root `vite.config.js` holds workspace
  tooling (lint/fmt/test); `examples/web/vite.config.ts` holds app build config.
- The Gradle build invokes npm scripts (`build:web`, `build:core`) via
  `examples/android-app/build.gradle`; it needs the Android SDK
  (`local.properties` with `sdk.dir=...`) and Bare Kit prebuilds (see below).

## Repo map (ownership)

| Path                                                                                                            | Owner        | Contents                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `core/messages`                                                                                                 | framework    | Wire protocol: codec, plugin kernel, RPC messenger, host IPC, types                                            |
| `core/server`, `core/lib`, `core/main.core.ts`                                                                  | framework    | Unified loopback HTTP+WS server (web app + media + protocol socket, cookie auth) + Bare worklet entry          |
| `plugins`                                                                                                       | framework    | Canonical plugins (`core.health`, `core.discovery`, `core.permissions`, `vendor.media`) + typed event builders |
| `web/transports`, `web/websocket-client.ts`                                                                     | framework    | `MessageTransport` + WebSocket (same-origin, cookie login, reconnect) / mock transports                        |
| `android`                                                                                                       | framework    | Android host library (`:bare-host`): IPC coordinator, host plugin registry, WebView client                     |
| `ios`                                                                                                           | framework    | iOS host Swift package (`BareHost`): IPC coordinator, host plugin registry                                     |
| `examples/web`                                                                                                  | example      | Reference web UI (lit-html + nanostores + Tailwind)                                                            |
| `examples/android-app`                                                                                          | example      | Reference Android app consuming `:bare-host` + web assets                                                      |
| `examples/ios-app`                                                                                              | example      | Reference iOS app consuming `BareHost` + web assets (xcodegen project)                                         |
| `e2e`                                                                                                           | tooling      | Playwright specs against the mock transport                                                                    |
| `scripts`                                                                                                       | tooling      | Dev-bare runner, playwright browser wrapper, prebuild fetcher                                                  |
| `prebuilds`                                                                                                     | build output | Bare Kit prebuilds (gitignored, fetched from a GitHub release)                                                 |
| `vision.md`, `plan.md`, `CONTEXT.md`, `rendering.md`, `ios-handoff.md`, `RELEASING.md`, `CHANGELOG.md`, `docs/` | docs         | Decision + planning documents; ADRs live in `docs/adr/`                                                        |

The framework's public API surface is the `exports` map in `package.json`
(`@less/bare/core`, `/plugins`, `/plugins/*/events`, `/transports`). Per the
stability contract in `vision.md`, breaking the wire protocol, plugin
contracts, JS exports, or Kotlin host API is a **major-version event**.
Everything else (layout, tooling, internals) can change freely.

## Do / don't

- **Do** read `vision.md` before deciding what belongs here.
- **Do** keep `vp check` and `vp test` green before finishing a change.
- **Do** co-locate unit tests as `*.test.ts` next to the source they cover.
- **Do** fetch Bare Kit prebuilds via the documented script before Android or
  iOS work (never commit them): `gh release download --repo holepunchto/bare-kit
<version>` then unzip `android/*` and `ios/*` into `prebuilds/`.
- **Don't** commit build output: `core/main.core.gen.js`, web assets under
  `examples/android-app/src/main/assets/`, `prebuilds/`,
  `examples/ios-app/addons/`, `examples/ios-app/Resources/`, `.playwright-browsers/`.
- **Don't** touch the `<!--VITE PLUS START/END-->` block — Vite+ manages it.
- **Don't** reference `npm run <script>` in docs when a `vp` built-in exists;
  `vp run <name>` runs a package script explicitly.

## Releasing

Releases are **tag-driven and single-version** (`vX.Y.Z`): CI builds and
publishes every artifact for the tag together. Follow `RELEASING.md`, never
ad-hoc publish.

## Planning

The transport/auth roadmap lives in `plan.md` (Phase 1 done; Phase 2 unifies
the loopback server + cookie auth; Phase 3 is release readiness). Follow it
when extending the host/transport surface.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `AndersCan/less-bare-android`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped to default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
