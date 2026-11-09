import {
  type CoreError,
  type Either,
  MessageType,
  createPluginBus,
  createProtocolMessenger,
} from '@ekrooh/bare/core';
import { createJoinWait } from './join-wait';
import { pageView, render } from './render';
import { transport } from './transport';
import { type VoteState, voteEvents } from './vote-events';

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

let state: VoteState | undefined;
let message = '';
const joinWait = createJoinWait();

function show() {
  const view = pageView(state, message, joinWait);
  render(app, view, { vote, join });
}

/** An action's failure shows its message; its result updates the page. */
async function act(
  call: Promise<Either<CoreError, VoteState>>,
): Promise<boolean> {
  const [error, result] = await call;
  message =
    error || !result
      ? (error?.message ?? 'Something went wrong. Try again.')
      : '';
  if (result) state = result;
  show();
  return !error && !!result;
}

/** The once-a-second poll updates the counts but leaves any message alone. */
async function refresh() {
  const [error, result] = await bus.invoke(voteEvents.list());
  if (error || !result) return;
  state = result;
  show();
}

const vote = (id: string) => act(bus.invoke(voteEvents.cast(id)));
const join = async (code: string) => {
  const ok = await act(bus.invoke(voteEvents.join(code)));
  joinWait.joined(ok);
  show();
  return ok;
};

show();
void refresh();
// Votes from other devices arrive in the backend; ask for them once a second.
setInterval(() => void refresh(), 1000);
