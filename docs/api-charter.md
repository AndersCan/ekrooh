# API charter

> **Draft, inferred from the existing code and README. Owner: edit freely; this is the one file you hand-write.**
> Agents conform to it and never edit it. Executable examples live in
> [`charter.test.ts`](../charter.test.ts); a failing example means the API drifted
> from this page or this page needs your edit.

## Feel

The API should feel **boring, small and typed**. A feature is one obvious call;
the framework hides the wire, the runtime and the platform.

## Rules

1. **The UI never knows where it runs.** Feature code never branches on worklet,
   Bare, host IPC or platform. It talks as if only a WebSocket backend exists.
2. **Callers use typed event builders, never raw frames.**
   `healthEvents.health.ping('hi')`, not hand-built headers.
3. **A plugin is its specs plus handlers, declared once.** One `definePlugin`
   call carries id, capabilities and handlers. No second registration step.
4. **Unsupported means a deterministic error.** An event a runtime can't serve
   answers `UNSUPPORTED_EVENT` (or `UNSUPPORTED_CAPABILITY`). It never throws
   across the wire, hangs or silently no-ops.
5. **Capabilities are opt-in plugins.** The core stays small. Product features
   belong in consumer plugins, not in `@ekrooh/bare`.
6. **Small public surface.** Every new export is a stability-boundary change and
   needs a reason. Prefer extending an existing plugin or builder over adding a
   subpath.
7. **Parity by contract, not by code.** Android and iOS follow the same plugin
   contracts. Behavior that differs is reported through capabilities, not hidden.

## Examples

Good: one call, typed, no platform knowledge.

```ts
const envelope = healthEvents.health.ping('hi');
```

Good: a plugin declared once.

```ts
definePlugin('demo.greeter', specs, {
  capabilities: ['greet'],
  invoke: { greet: (args) => ok({ text: `hello ${args.name}` }) },
});
```

Bad: platform branching in feature code, hand-built frames, or a handler that
throws for an event it doesn't support.

## Open for the owner

- Which of the seven rules are wrong or missing?
- Naming taste (event names, plugin ids) is not yet written down.
