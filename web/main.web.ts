import { html, render } from 'lit-html';
import { cache } from 'lit-html/directives/cache.js';
import { getPagePath } from '@nanostores/router';
import {
  MessageType,
  createPluginBus,
  createProtocolMessenger,
} from '../core/messages';
import { discoveryEvents } from '../plugins/discovery/events';
import { healthEvents } from '../plugins/health/events';
import { permissionEvents } from '../plugins/permissions/events';
import { $capabilitiesSummary, $lastResult } from './app-state';
import { $currentTime } from './current-time';
import { handleMessage } from './handle-message';
import { $router, type AppPage } from './router';
import { getTransport } from './transport';
import { useStore } from './use-store';

const transport = getTransport();
const messenger = createProtocolMessenger((request, payload) => {
  transport.send(MessageType.ENVELOPE, request, payload);
});
const bus = createPluginBus(messenger);

main();

function main() {
  transport.subscribe((message) => {
    messenger.handleIncoming(message.header);
    handleMessage(message);
  });

  void runDiscovery();

  const renderRoot = document.getElementById('render-root');
  // `render` returns a RootPart; if this tree is ever torn down, call
  // rootPart.setConnected(false) on that value first (see rendering.md).
  render(
    html`
      <header class="border-b border-slate-200 mb-6 pb-3">
        <nav class="flex flex-wrap gap-4 text-sm" aria-label="Main">
          <a class="text-blue-600 hover:underline" href="${getPagePath($router, 'home')}">
            Health checks
          </a>
          <a class="text-blue-600 hover:underline" href="${getPagePath($router, 'demo')}">
            Demo route
          </a>
        </nav>
      </header>
      <main>${useStore($router, (page) => cache(routeView(page)))}</main>
    `,
    renderRoot!,
  );
}

function routeView(page: AppPage | undefined) {
  if (!page) {
    return html`
      <section aria-label="Not found">
        <h1 class="text-xl font-semibold mb-2">Not found</h1>
        <p class="text-slate-600 mb-4">No route matches this URL.</p>
        <a class="text-blue-600 hover:underline" href="${getPagePath($router, 'home')}">Back to health checks</a>
      </section>
    `;
  }
  switch (page.route) {
    case 'home':
      return cache(healthChecksView());
    case 'demo':
      return cache(demoView());
    default:
      return html`<p class="text-slate-600">Unknown route.</p>`;
  }
}

function healthChecksView() {
  return html`
    <section aria-label="Plugin health checks">
      <h1 class="text-2xl font-bold mb-4">Plugin Health Checks</h1>
      <p class="mb-4 text-gray-600">
        Runtime time: ${useStore($currentTime, (t) => new Date(t).toLocaleTimeString())}
      </p>
      <p class="mb-4 text-sm text-slate-600">${useStore($capabilitiesSummary)}</p>

      <div style="margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
        <button
          class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          @click=${() => void runPing()}
        >
          Ping
        </button>

        <button
          class="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600"
          @click=${() => void runPayloadEcho()}
        >
          Payload Echo
        </button>

        <button
          class="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
          @click=${() => void runRoundtrip()}
        >
          Roundtrip
        </button>

        <button
          class="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700"
          @click=${() => void runStoragePermission()}
        >
          Storage permission
        </button>
      </div>
      <p class="text-sm text-gray-700">${useStore($lastResult)}</p>
    </section>
  `;
}

function demoView() {
  return html`
    <section aria-label="Demo route">
      <h1 class="text-2xl font-bold mb-4">Demo route</h1>
      <p class="mb-4 text-slate-600">
        This page exists to exercise <code class="text-sm bg-slate-100 px-1 rounded">@nanostores/router</code> and
        lit-html <code class="text-sm bg-slate-100 px-1 rounded">cache()</code>.
      </p>
      <p class="text-sm text-slate-500">Path: <span class="font-mono">/demo</span></p>
    </section>
  `;
}

async function runDiscovery() {
  const [error, data] = await bus.invoke(discoveryEvents.discovery.list());
  if (error) {
    $capabilitiesSummary.set(`Discovery failed: ${error.message}`);
    return;
  }
  const ids = data?.capabilities?.map((c) => c.pluginId).join(', ') ?? '';
  $capabilitiesSummary.set(
    `Discovery v${data?.schemaVersion}: ${data?.capabilities?.length ?? 0} plugin(s) — ${ids}`,
  );
}

async function runPing() {
  const [err, result] = await bus.invoke(healthEvents.health.ping('hello'));
  $lastResult.set(err ? `PING failed: ${err.message}` : `PING ok: ${result?.message}`);
}

async function runPayloadEcho() {
  const payload = new TextEncoder().encode('payload-check');
  const [err, result] = await bus.invoke(healthEvents.health.payloadEcho('sample', payload));
  $lastResult.set(
    err
      ? `PAYLOAD failed: ${err.message}`
      : `PAYLOAD ok: ${result?.label} (${result?.payloadSize} bytes)`,
  );
}

async function runRoundtrip() {
  const [err, result] = await bus.invoke(healthEvents.health.roundtrip());
  $lastResult.set(err ? `ROUNDTRIP failed: ${err.message}` : `ROUNDTRIP ok: ${result?.pong}`);
}

async function runStoragePermission() {
  const [err, r] = await bus.invoke(permissionEvents.permissions.requestStorage());
  $lastResult.set(
    err
      ? `Storage permission failed: ${err.message}`
      : `Storage permission: granted=${String(r?.granted)}`,
  );
}
