import { html, render } from 'lit-html';
import {
  MessageType,
  createPluginBus,
  createProtocolMessenger,
} from '@ekrooh/bare/core';
import { basicEvents } from '../shared/basic-events';
import { transport } from './transport';

const messenger = createProtocolMessenger((request, payload) => {
  transport.send(MessageType.ENVELOPE, request, payload);
});
const bus = createPluginBus(messenger);

const renderRoot = document.getElementById('render-root');

let pingStatus = 'Not pinged yet.';
let beeps = 0;
let lastBeep = 0;

transport.subscribe((message) => {
  // Let the messenger match INVOKE_RESPONSE requestIds back to `bus.invoke`.
  messenger.handleIncoming(message.header);
  // Backend → web push (a server-initiated DISPATCH, no requestId).
  if (
    message.header.type === 'DISPATCH' &&
    message.header.pluginId === 'app.basic' &&
    message.header.event === 'basic.beep'
  ) {
    beeps += 1;
    lastBeep = Number(
      (message.header.args as { count?: number })?.count ?? beeps,
    );
    renderApp();
  }
});

async function ping() {
  pingStatus = 'Pinging…';
  renderApp();
  const [err, result] = await bus.invoke(basicEvents.ping('hello consumer'));
  pingStatus = err
    ? `PING failed: ${err.message}`
    : `PING ok: ${result?.message} (${new Date(result?.ts ?? 0).toLocaleTimeString()})`;
  renderApp();
}

function renderApp() {
  render(
    html`
      <main class="card">
        <h1>Consumer basic</h1>
        <p class="lede">
          The smallest <code>@ekrooh/bare</code> consumer: your own plugin
          (<code>app.basic</code>), one invoke, one backend → web push.
        </p>
        <button @click=${() => void ping()}>Ping</button>
        <p class="status">${pingStatus}</p>
        <p class="status">Beeps received: ${beeps}</p>
        <p class="status">Last beep: #${lastBeep}</p>
      </main>
    `,
    renderRoot!,
  );
}

renderApp();
