import type { VoteOption } from './vote-events';

export type View =
  | { kind: 'loading' }
  | { kind: 'ready'; options: VoteOption[] };

export type Actions = { vote(id: string): void };

/** The only file that touches the DOM. Swap it to change what you see. */
export function render(root: HTMLElement, view: View, actions: Actions): void {
  if (view.kind === 'loading') {
    const text = document.createElement('p');
    text.textContent = 'Connecting…';
    root.replaceChildren(text);
    return;
  }
  const heading = document.createElement('h1');
  heading.textContent = 'Vote';
  const buttons = view.options.map((option) => {
    const button = document.createElement('button');
    button.textContent = `${option.label} (${option.votes})`;
    button.addEventListener('click', () => actions.vote(option.id));
    return button;
  });
  root.replaceChildren(heading, ...buttons);
}
