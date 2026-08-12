# plugins/

Canonical plugins shipped with the framework. Each plugin has an
implementation (`plugin.ts`) and typed event builders (`events.ts`).

| Plugin         | ID                 | Events                                                  | Runtime                           |
| -------------- | ------------------ | ------------------------------------------------------- | --------------------------------- |
| `health/`      | `core.health`      | `health.ping`, `health.payloadEcho`, `health.roundtrip` | `bare`                            |
| `discovery/`   | `core.discovery`   | `discovery.list`                                        | `bare` (merges host capabilities) |
| `permissions/` | `core.permissions` | `permissions.requestStorage`                            | host-delegated stub               |
| `media/`       | `vendor.media`     | `media.pick`, `media.capture`                           | `bare` (host-delegated pick)      |

`index.ts` exports `createDefaultPlugins(deps)` used by the worklet entry.

### `vendor.media` — out-of-band binary transfer reference

`media/` demonstrates the framework's rule for large binaries: **never cross
the wire protocol or a WebView bridge**. The host picks/captures a file
natively and returns its path (`HOST_INVOKE_REQUEST`); the worklet mounts the
file on the loopback server (`core/server/static-file-server.ts`) and returns a
plain URL. The web layer loads the URL directly — one serving implementation
for iOS, Android, desktop and browser. The Android reference host wires a real
native picker/camera; the iOS reference host's real picker/camera is part of
the iOS parity worklist.

`vendor.media` stays a **default plugin** (so discovery lists 4): the loopback
serving mechanism it exercises is framework plumbing, not a product feature.
Consumers keep building their own pickers/cameras as plugins on top of it.

Authoring rules (also in `core/messages/readme.md`):

- Plugin IDs are namespaced (`vendor.plugin`).
- Declare events as typed `EventSpec`s (one per event: `pluginId`, `name`,
  `args`, `result`) and build the manifest with `definePlugin` — the `events`
  list and the handler table are generated, handlers get typed args, and the
  typed builders in `events.ts` are `invokeEvent(spec, args, payload)` wrappers
  over the same spec. No hand-written if-chains.
- Use `dispatch` for side effects, `invoke` for request/response.
- Build results with the shared `ok()` / `err()` helpers and canonical
  `ErrorCode` values from `@less/bare/core`.
- The router synthesizes `UNSUPPORTED_EVENT` for events not declared in the
  manifest and wraps adapter throws as `PLUGIN_ERROR` — don't hand-roll those.
- Event builders live in `events.ts` and are part of the public JS surface
  (`@less/bare/plugins/*/events`).

This is **not** where product features live — consumers add their own plugins.
