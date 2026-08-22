import { html, render } from 'lit-html';
import { cache } from 'lit-html/directives/cache.js';
import { getPagePath } from '@nanostores/router';
import {
  MessageType,
  createPluginBus,
  createProtocolMessenger,
} from '@ekrooh/bare/core';
import { discoveryEvents } from '@ekrooh/bare/plugins/discovery/events';
import { healthEvents } from '@ekrooh/bare/plugins/health/events';
import { mediaEvents } from '@ekrooh/bare/plugins/media/events';
import { permissionEvents } from '@ekrooh/bare/plugins/permissions/events';
import { type MessageTransport } from '@ekrooh/bare/transports';
import { $capabilitiesSummary, $lastResult, $mediaUrl } from './app-state';
import { $currentTime } from './current-time';
import { handleMessage } from './handle-message';
import { safeMediaUrl } from './media-url';
import { $router, type AppPage } from './router';
import { getTransport } from './transport';
import { useStore } from './use-store';

let transport: MessageTransport;
let bus: ReturnType<typeof createPluginBus>;

async function boot() {
  transport = await getTransport();
  const messenger = createProtocolMessenger((request, payload) => {
    transport.send(MessageType.ENVELOPE, request, payload);
  });
  bus = createPluginBus(messenger);
  transport.subscribe((message) => {
    messenger.handleIncoming(message.header);
    handleMessage(message);
  });
  main();
}

boot();

function main() {
  // The Android shell serves the app from /assets/index.html and the iOS shell
  // (WKWebView) from a shell-specific path ending in index.html — neither
  // matches a route. Normalize to the home route so first load doesn't land on
  // "Not found".
  if (window.location.pathname.endsWith('/index.html')) {
    $router.open('/', true);
  }

  void runDiscovery();

  const renderRoot = document.getElementById('render-root');
  // `render` returns a RootPart; if this tree is ever torn down, call
  // rootPart.setConnected(false) on that value first (see rendering.md).
  render(
    html`
      <header class="mb-6 border-b border-slate-200 pb-3">
        <nav class="flex flex-wrap gap-4 text-sm" aria-label="Main">
          <a
            class="text-blue-600 hover:underline"
            href="${getPagePath($router, 'home')}"
          >
            Health checks
          </a>
          <a
            class="text-blue-600 hover:underline"
            href="${getPagePath($router, 'demo')}"
          >
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
        <h1 class="mb-2 text-xl font-semibold">Not found</h1>
        <p class="mb-4 text-slate-600">No route matches this URL.</p>
        <a
          class="text-blue-600 hover:underline"
          href="${getPagePath($router, 'home')}"
          >Back to health checks</a
        >
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
      <h1 class="mb-4 text-2xl font-bold">Plugin Health Checks</h1>
      <p class="mb-4 text-gray-600">
        Runtime time:
        ${useStore($currentTime, (t) => new Date(t).toLocaleTimeString())}
      </p>
      <p class="mb-4 text-sm text-slate-600">
        ${useStore($capabilitiesSummary)}
      </p>

      <div
        style="margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;"
      >
        <button
          class="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
          @click=${() => void runPing()}
        >
          Ping
        </button>

        <button
          class="rounded bg-purple-500 px-4 py-2 text-white hover:bg-purple-600"
          @click=${() => void runPayloadEcho()}
        >
          Payload Echo
        </button>

        <button
          class="rounded bg-gray-500 px-4 py-2 text-white hover:bg-gray-600"
          @click=${() => void runRoundtrip()}
        >
          Roundtrip
        </button>

        <button
          class="rounded bg-amber-600 px-4 py-2 text-white hover:bg-amber-700"
          @click=${() => void runStoragePermission()}
        >
          Storage permission
        </button>

        <button
          class="rounded bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700"
          @click=${() => void runMediaPick()}
        >
          Pick image
        </button>

        <button
          class="rounded bg-teal-600 px-4 py-2 text-white hover:bg-teal-700"
          @click=${() => void runMediaCapture()}
        >
          Capture image
        </button>
      </div>
      <p class="text-sm text-gray-700">${useStore($lastResult)}</p>

      ${useStore($mediaUrl, (url) =>
        url
          ? html`<img
              alt="Picked media"
              class="mt-4 max-w-full rounded border border-slate-300"
              src="${url}"
              referrerpolicy="no-referrer"
            />`
          : null,
      )}
    </section>
  `;
}

function demoView() {
  return html`
    <section aria-label="Demo route">
      <h1 class="mb-4 text-2xl font-bold">Demo route</h1>
      <p class="mb-4 text-slate-600">
        This page exists to exercise
        <code class="rounded bg-slate-100 px-1 text-sm"
          >@nanostores/router</code
        >
        and lit-html
        <code class="rounded bg-slate-100 px-1 text-sm">cache()</code>.
      </p>
      <p class="text-sm text-slate-500">
        Path: <span class="font-mono">/demo</span>
      </p>
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
  $lastResult.set(
    err ? `PING failed: ${err.message}` : `PING ok: ${result?.message}`,
  );
}

async function runPayloadEcho() {
  const payload = new TextEncoder().encode('payload-check');
  const [err, result] = await bus.invoke(
    healthEvents.health.payloadEcho('sample', payload),
  );
  $lastResult.set(
    err
      ? `PAYLOAD failed: ${err.message}`
      : `PAYLOAD ok: ${result?.label} (${result?.payloadSize} bytes)`,
  );
}

async function runRoundtrip() {
  const [err, result] = await bus.invoke(healthEvents.health.roundtrip());
  $lastResult.set(
    err ? `ROUNDTRIP failed: ${err.message}` : `ROUNDTRIP ok: ${result?.pong}`,
  );
}

async function runStoragePermission() {
  const [err, r] = await bus.invoke(
    permissionEvents.permissions.request('storage'),
  );
  $lastResult.set(
    err
      ? `Storage permission failed: ${err.message}`
      : `Storage permission: ${String(r?.permission)}=${String(r?.status)}`,
  );
}

async function runMediaPick() {
  const [err, r] = await bus.invoke(mediaEvents.media.pick('image'));
  $lastResult.set(err ? `Media pick failed: ${err.message}` : 'Media pick ok');
  $mediaUrl.set(safeMediaUrl(r?.url));
}

async function runMediaCapture() {
  const [err, r] = await bus.invoke(mediaEvents.media.capture('image'));
  $lastResult.set(
    err ? `Media capture failed: ${err.message}` : 'Media capture ok',
  );
  $mediaUrl.set(safeMediaUrl(r?.url));
}
