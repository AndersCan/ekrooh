# consumer-basic

The smallest **runnable** `@ekrooh/bare` consumer — a template to copy, not a
product. It ties the pieces the docs describe into one app:

| Piece                                                                    | File                                  | Docs                                                |
| ------------------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------- |
| Consumer worklet entry (`createWorkletRuntime` + `resolveWorkletConfig`) | `worklet/entry.ts`                    | consumers/end-to-end, consumers/worklet-entry       |
| Your own plugin (`definePlugin`, one invoke + one backend → web push)    | `worklet/basic-plugin.ts`             | consumers/authoring-plugins, consumers/backend-push |
| Typed event surface shared by worklet + web                              | `shared/basic-events.ts`              | consumers/authoring-plugins                         |
| Web layer via `@ekrooh/bare` transports + plugin events                  | `web/main.web.ts`, `web/transport.ts` | core-concepts/transports                            |
| Real-stack e2e (worklet serves the built app, same-origin WS)            | `e2e/real-stack.spec.ts`              | hosts/testing                                       |

## What it does

`app.basic` has one invoke (`basic.ping`) and one backend → web push
(`basic.beep`). Every ping also pushes a beep, so the roundtrip is
deterministic and the e2e asserts both directions.

## Run it

From the repo root (after `npm run build:pkg` — the web build resolves
`@ekrooh/bare` through the `dist/` exports map):

```bash
# Dev loop: Vite web app + bare worklet backend (auth off, port 8080)
npm --prefix examples/consumer-basic run dev

# Real-stack e2e: boots the worklet serving the built web app from its
# loopback server and drives Playwright against it (like on device).
# Pick a free port when 8080 is busy (e.g. a Justus dev backend).
CONSUMER_BASIC_PORT=8091 npm run test:e2e:consumer
```

The e2e pattern is the one consumers need for their own apps (docs
hosts/testing.mdx): boot the worklet serving the built web app, assert against
`http://127.0.0.1:<port>`, and fail on any `console.error`/`pageerror`.
