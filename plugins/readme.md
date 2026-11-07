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

Large binaries never cross the wire protocol or a WebView bridge. The host picks or captures the file natively and returns its path (`HOST_INVOKE_REQUEST`). The worklet mounts it on the loopback server (`core/server/static-file-server.ts`) under a CSPRNG id and returns only the URL (never the native path), which the web layer loads directly. `kind` is allowlisted (`image`/`video`); the host deadline is 4 min 55 s, just under the page's 5-minute invoke timeout; non-canonical host error codes become `HOST_ERROR`.

It stays a default plugin because the loopback serving is framework plumbing. Android and iOS both have a native picker and camera.

## Ids and args

The `core.*` and `vendor.*` namespaces are reserved for these plugins; the registry refuses any other id there. Event args are untrusted page input: each plugin checks what it uses (`vendor.media` allowlists `kind`; `core.logs` rejects a non-number `tail` and unknown `level`/`source`; the hosts allowlist permission ids). `permissions.request` declares `hostTimeoutMs` (5 min) because a prompt waits for the user.

Product features belong in consumer plugins, not here.
