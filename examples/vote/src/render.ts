import { submitJoin } from './join-wait';
import type { VoteState } from './vote-events';

/** Your poll. `id` is what devices share (a-z, 0-9, -, up to 32 characters);
 * `label` is what you see. Devices count every id they are sent. */
const options = [
  { id: 'tea', label: 'Tea' },
  { id: 'coffee', label: 'Coffee' },
  { id: 'water', label: 'Water' },
];

export type View =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      state: VoteState;
      message: string;
      /** Seconds since a successful Join with no device connected yet. */
      waiting?: number;
    };

export type Actions = {
  vote(id: string): void;
  join(code: string): Promise<boolean>;
};

/** One line for how many other devices are connected. */
export function connectionText(connected: number, waiting?: number): string {
  if (connected === 0 && waiting !== undefined) {
    return waiting < 60
      ? 'Joined. Looking for the other device…'
      : 'Still looking for the other device. A first connection can be slow: wait a little, then restart both apps.';
  }
  if (connected === 0) return 'No other device yet';
  return connected === 1
    ? '1 other device connected'
    : `${connected} other devices connected`;
}

type Page = {
  buttons: HTMLElement;
  invite: HTMLElement;
  status: HTMLElement;
  message: HTMLElement;
  buttonById: Map<string, HTMLElement>;
};

const pages = new WeakMap<HTMLElement, Page>();

/** The only file that touches the DOM. Swap it to change what you see.
 * The page is built once and then updated in place, so the Join box keeps
 * what you typed while votes arrive. */
export function render(root: HTMLElement, view: View, actions: Actions): void {
  if (view.kind === 'loading') {
    const text = document.createElement('p');
    text.textContent = 'Connecting…';
    root.replaceChildren(text);
    pages.delete(root);
    return;
  }
  let page = pages.get(root);
  if (!page) {
    page = build(root, actions);
    pages.set(root, page);
  }
  for (const { id, label } of options) {
    const votes = Object.hasOwn(view.state.votes, id)
      ? view.state.votes[id]
      : 0;
    const option = { label, votes };
    const button = page.buttonById.get(id);
    if (button) button.textContent = `${option.label} (${option.votes})`;
  }
  page.invite.textContent = view.state.invite;
  page.status.textContent = connectionText(view.state.connected, view.waiting);
  page.message.textContent = view.message;
}

function build(root: HTMLElement, actions: Actions): Page {
  const heading = document.createElement('h1');
  heading.textContent = 'Vote';
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const buttonById = new Map<string, HTMLElement>();
  for (const { id } of options) {
    const button = document.createElement('button');
    button.dataset.id = id;
    button.addEventListener('click', () => actions.vote(id));
    buttonById.set(id, button);
    buttons.append(button);
  }

  const status = document.createElement('p');
  status.className = 'status';
  status.setAttribute('role', 'status');

  const inviteLabel = document.createElement('p');
  inviteLabel.textContent = 'Your invite code. Paste it on another device:';
  const invite = document.createElement('code');
  invite.className = 'invite';

  const form = document.createElement('form');
  const input = document.createElement('input');
  input.placeholder = 'Paste a code here';
  input.setAttribute('aria-label', 'Invite code from another device');
  input.autocomplete = 'off';
  const joinButton = document.createElement('button');
  joinButton.textContent = 'Join';
  form.append(input, joinButton);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitJoin(input, actions.join);
  });

  const message = document.createElement('p');
  message.setAttribute('role', 'alert');

  root.replaceChildren(
    heading,
    buttons,
    status,
    inviteLabel,
    invite,
    form,
    message,
  );
  return { buttons, invite, status, message, buttonById };
}

/** What to show for the current state; the wait only counts while no peer is connected. */
export function pageView(
  state: VoteState | undefined,
  message: string,
  wait: { seconds(connected: number): number | undefined },
): View {
  if (!state) return { kind: 'loading' };
  return {
    kind: 'ready',
    state,
    message,
    waiting: wait.seconds(state.connected),
  };
}
