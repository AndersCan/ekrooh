# plugins/

Canonical plugins shipped with the framework. Each has `plugin.ts` (implementation) and `events.ts` (typed builders, exported as `@ekrooh/bare/plugins/*/events`). `index.ts` exports `createDefaultPlugins(deps)` for the worklet entry.

| Plugin         | ID                 | Events                                                  | Runtime                           |
| -------------- | ------------------ | ------------------------------------------------------- | --------------------------------- |
| `health/`      | `core.health`      | `health.ping`, `health.payloadEcho`, `health.roundtrip` | `bare`                            |
| `discovery/`   | `core.discovery`   | `discovery.list`                                        | `bare` (merges host capabilities) |
| `permissions/` | `core.permissions` | `permissions.request`, `permissions.status`             | host-delegated stub               |
| `media/`       | `vendor.media`     | `media.pick`, `media.capture`                           | `bare` (host-delegated pick)      |
| `logs/`        | `core.logs`        | `logs.view`, `logs.clear`                               | `bare` (ring-fed capture store)   |

## `vendor.media`: out-of-band binary reference

Large binaries never cross the wire protocol or a WebView bridge. The host picks or captures the file natively and returns its path (`HOST_INVOKE_REQUEST`). The worklet mounts it on the loopback server (`core/server/static-file-server.ts`) and returns a URL that the web layer loads directly.

It stays a default plugin because the loopback serving is framework plumbing. Android has a native picker and camera; iOS is on the parity worklist.

Product features belong in consumer plugins, not here.
