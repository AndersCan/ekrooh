# examples/web

Reference web UI for `@ekrooh/bare` (Vite, lit-html, nanostores, Tailwind). It mirrors the docs [Web Quickstart](https://anderscan.github.io/ekrooh/getting-started/web-quickstart): a browser-only hello world that pings the loopback backend via `core.health`.

```bash
npm install
npm run dev   # loopback backend on :8080 + Vite; open the URL Vite prints, click Ping
```

- `transport.ts`: `getTransport()`. WebSocket to `ws://localhost:8080` in dev, mock in `mock` mode.
- `main.web.ts`: boots transport, `createProtocolMessenger`, `createPluginBus`; wires **Ping**.
- `use-store.ts`: lit-html `useStore` directive ([Web Rendering](https://anderscan.github.io/ekrooh/consumers/rendering)).
