import type { VoteState } from "./vote-events";

export type View =
  { kind: "loading" } | { kind: "ready"; state: VoteState; message: string };

export type Actions = { vote(id: string): void; join(code: string): void };

/** One line for how many other devices are connected. */
export function connectionText(connected: number): string {
  if (connected === 0) return "No other device yet";
  return connected === 1
    ? "1 other device connected"
    : `${connected} other devices connected`;
}

type Page = {
  buttons: HTMLElement;
  invite: HTMLElement;
  status: HTMLElement;
  message: HTMLElement;
  optionIds: string;
};

const pages = new WeakMap<HTMLElement, Page>();

/** The only file that touches the DOM. Swap it to change what you see.
 * The page is built once and then updated in place, so the Join box keeps
 * what you typed while votes arrive. */
export function render(root: HTMLElement, view: View, actions: Actions): void {
  if (view.kind === "loading") {
    const text = document.createElement("p");
    text.textContent = "Connecting…";
    root.replaceChildren(text);
    pages.delete(root);
    return;
  }
  let page = pages.get(root);
  if (!page) {
    page = build(root, actions);
    pages.set(root, page);
  }
  const ids = view.state.options.map((o) => o.id).join(",");
  if (ids !== page.optionIds) {
    page.optionIds = ids;
    page.buttons.replaceChildren(
      ...view.state.options.map((option) => {
        const button = document.createElement("button");
        button.dataset.id = option.id;
        button.addEventListener("click", () => actions.vote(option.id));
        return button;
      }),
    );
  }
  for (const option of view.state.options) {
    const button = page.buttons.querySelector<HTMLElement>(
      `[data-id="${option.id}"]`,
    );
    if (button) button.textContent = `${option.label} (${option.votes})`;
  }
  page.invite.textContent = view.state.invite;
  page.status.textContent = connectionText(view.state.connected);
  page.message.textContent = view.message;
}

function build(root: HTMLElement, actions: Actions): Page {
  const heading = document.createElement("h1");
  heading.textContent = "Vote";
  const buttons = document.createElement("div");
  buttons.className = "buttons";

  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");

  const inviteLabel = document.createElement("p");
  inviteLabel.textContent = "Your invite code. Paste it on another device:";
  const invite = document.createElement("code");
  invite.className = "invite";

  const form = document.createElement("form");
  const input = document.createElement("input");
  input.placeholder = "Paste a code here";
  input.setAttribute("aria-label", "Invite code from another device");
  input.autocomplete = "off";
  const joinButton = document.createElement("button");
  joinButton.textContent = "Join";
  form.append(input, joinButton);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.join(input.value);
    input.value = "";
  });

  const message = document.createElement("p");
  message.setAttribute("role", "alert");

  root.replaceChildren(
    heading,
    buttons,
    status,
    inviteLabel,
    invite,
    form,
    message,
  );
  return { buttons, invite, status, message, optionIds: "" };
}
