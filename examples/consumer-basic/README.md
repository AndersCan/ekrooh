# consumer-basic

The smallest runnable `@ekrooh/bare` consumer. A template to copy, not a product.

- `worklet/entry.ts`: worklet entry (`createWorkletRuntime`, `resolveWorkletConfig`). Docs: consumers/end-to-end, consumers/worklet-entry.
- `worklet/basic-plugin.ts`: own plugin (invoke plus backend push). Docs: consumers/authoring-plugins, consumers/backend-push.
- `shared/basic-events.ts`: typed events shared by worklet and web.
- `web/main.web.ts`, `web/transport.ts`: web layer. Docs: core-concepts/transports.
- `e2e/real-stack.spec.ts`: real-stack e2e. Docs: hosts/testing.

`app.basic` has one invoke (`basic.ping`) and one push (`basic.beep`); every ping also pushes a beep, and the e2e asserts both.

## Run

From the repo root, after `npm run build:pkg` (the web build resolves `@ekrooh/bare` through `dist/`):

```bash
npm --prefix examples/consumer-basic run dev                # Vite app + worklet on :8080
CONSUMER_BASIC_PORT=8091 npm run test:e2e:consumer          # free port if 8080 is busy
```

The e2e boots the worklet serving the built app on loopback and fails on any `console.error` or `pageerror`. Consumer apps should copy this pattern (docs: hosts/testing.mdx).
