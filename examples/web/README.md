# examples/web

Reference web UI for `@ekrooh/bare` — Vite + lit-html + nanostores + Tailwind.

It is the runnable mirror of the docs site's
[Web Quickstart](https://anderscan.github.io/ekrooh/getting-started/web-quickstart):
a browser-only hello world that connects to the loopback Bare backend over
WebSocket and exercises the canonical `core.health` plugin.

## Run it

From the repo root:

```bash
npm install
npm run dev
```

`npm run dev` starts the loopback Bare backend (port 8080) and the Vite dev
server together. Open the localhost URL Vite prints (typically
`http://localhost:5173`) and click **Ping** to see the round-trip.

## How it is wired

| File           | Role                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| `transport.ts` | `getTransport()` — `createWebSocketTransport()`; defaults to the          |
|                | loopback backend in dev (`ws://localhost:8080`), mock in `mock`           |
|                | mode.                                                                     |
| `main.web.ts`  | Boots the transport + `createProtocolMessenger` + `createPluginBus`,      |
|                | wires `healthEvents.health.ping()` to the **Ping** button.                |
| `use-store.ts` | The lit-html `useStore` directive + the rendering contract (see           |
|                | [Web Rendering](https://anderscan.github.io/ekrooh/consumers/rendering)). |

No native host (Android/iOS) is involved in this loop — it is the fastest way to
see the model work in a browser.
