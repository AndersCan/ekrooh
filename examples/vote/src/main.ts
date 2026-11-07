import {
  MessageType,
  createPluginBus,
  createProtocolMessenger,
} from '@ekrooh/bare/core';
import { render, type View } from './render';
import { transport } from './transport';
import { voteEvents } from './vote-events';

const messenger = createProtocolMessenger((request, payload) => {
  transport.send(MessageType.ENVELOPE, request, payload);
});
const bus = createPluginBus(messenger);
transport.subscribe((message) => {
  messenger.handleIncoming(message.header);
});

const root = document.getElementById('app');
if (!root) throw new Error('index.html needs <div id="app">');
const app = root;

function show(view: View) {
  render(app, view, { vote });
}

async function load() {
  const [err, result] = await bus.invoke(voteEvents.list());
  if (err || !result) {
    console.error('vote.list failed', err);
    return;
  }
  show({ kind: 'ready', options: result.options });
}

async function vote(id: string) {
  const [err, result] = await bus.invoke(voteEvents.cast(id));
  if (err || !result) {
    console.error('vote.cast failed', err);
    return;
  }
  show({ kind: 'ready', options: result.options });
}

show({ kind: 'loading' });
void load();
