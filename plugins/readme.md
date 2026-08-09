# plugins/

Canonical plugins shipped with the framework. Each plugin has an
implementation (`plugin.ts`) and typed event builders (`events.ts`).

| Plugin         | ID                 | Events                                                  | Runtime                           |
| -------------- | ------------------ | ------------------------------------------------------- | --------------------------------- |
| `health/`      | `core.health`      | `health.ping`, `health.payloadEcho`, `health.roundtrip` | `bare`                            |
| `discovery/`   | `core.discovery`   | `discovery.list`                                        | `bare` (merges host capabilities) |
| `permissions/` | `core.permissions` | `permissions.requestStorage`                            | host-delegated stub               |

`index.ts` exports `createDefaultPlugins(deps)` used by the worklet entry.

Authoring rules (also in `core/messages/readme.md`):

- Plugin IDs are namespaced (`vendor.plugin`).
- Use `dispatch` for side effects, `invoke` for request/response.
- Return deterministic errors (`UNSUPPORTED_CAPABILITY`, `UNSUPPORTED_EVENT`).
- Event builders live in `events.ts` and are part of the public JS surface
  (`@less/bare/plugins/*/events`).

This is **not** where product features live — consumers add their own plugins.
