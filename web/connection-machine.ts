import {
  Actor,
  RealClock,
  event,
  state,
  type Clock,
  type Snapshot,
} from '@mantaq/core';

/**
 * The WebSocket connection state machine for `createWebSocketTransport`,
 * modeled with mantaq (internal-only — never part of the public `@ekrooh/bare`
 * surface). Owns the connection lifecycle, exponential backoff and retry cap.
 * There is no `?token=` upgrade-rejection fallback: the session token must
 * never appear in a URL (the loopback server rejects it), so a rejected
 * upgrade can only be retried as a fresh authenticated socket.
 */

export interface ConnectionMachineOptions {
  url: string;
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  clock?: Clock;
}

export type ConnectionStateName =
  | 'idle'
  | 'opening'
  | 'connected'
  | 'backoff'
  | 'gaveUp';

const idleState = state('idle')();
const openingState = state('opening')();
const connectedState = state('connected')();
const backoffState = state('backoff')();
const gaveUpState = state('gaveUp')().final();

const loginOk = event('LOGIN_OK')();
const loginFail = event('LOGIN_FAIL')();
const socketOpen = event('SOCKET_OPEN')();
const socketClose = event('SOCKET_CLOSE')();
const retryTimer = event('RETRY_TIMER')();

type ConnectionContext = {
  url: string;
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  retries: number;
};

export interface ConnectionMachine {
  url(): string;
  state(): ConnectionStateName;
  isConnected(): boolean;
  isGaveUp(): boolean;
  sendLoginOk(): void;
  sendLoginFail(): void;
  sendOpen(): void;
  sendClose(): void;
  /** Fires on every state/context change with the current state name. */
  onChange(fn: (state: ConnectionStateName) => void): () => void;
}

export function createConnectionMachine(
  options: ConnectionMachineOptions,
): ConnectionMachine {
  const context: ConnectionContext = {
    url: options.url,
    maxRetries: options.maxRetries,
    initialBackoffMs: options.initialBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
    retries: 0,
  };

  const actor = new Actor({
    inputs: [loginOk, loginFail, socketOpen, socketClose],
    internal: [retryTimer],
    outputs: [],
    states: [
      idleState,
      openingState,
      connectedState,
      backoffState,
      gaveUpState,
    ],
    initial: idleState,
    clock: options.clock ?? new RealClock(),
    context,
    setup: (m) => {
      m.effect(backoffState, ({ signal, context, clock, emit }) => {
        const s = context.get();
        const delay = Math.min(
          s.initialBackoffMs * 2 ** (s.retries - 1),
          s.maxBackoffMs,
        );
        clock.setTimeout(delay, () => {
          if (signal.aborted) return;
          emit({ type: 'RETRY_TIMER' });
        });
      });

      m.on(idleState, loginOk, () => ({ state: openingState }));
      m.on(idleState, loginFail, () => ({ state: openingState }));

      m.on(openingState, socketOpen, (_event, opts) => {
        const s = opts!.context.get();
        opts!.context.set({ ...s, retries: 0 });
        return { state: connectedState };
      });
      m.on(openingState, socketClose, (_event, opts) => {
        const s = opts!.context.get();
        // A close while still `opening` means the upgrade was rejected and the
        // `/login` cookie did not ride the handshake. There is no token-URL
        // fallback — retry (or give up at the cap) on a fresh socket instead.
        if (s.retries >= s.maxRetries) return { state: gaveUpState };
        opts!.context.set({ ...s, retries: s.retries + 1 });
        return { state: backoffState };
      });
      m.on(connectedState, socketClose, (_event, opts) => {
        const s = opts!.context.get();
        if (s.retries >= s.maxRetries) return { state: gaveUpState };
        opts!.context.set({ ...s, retries: s.retries + 1 });
        return { state: backoffState };
      });
      m.on(backoffState, retryTimer, () => ({ state: openingState }));
      // Defensive: a stray close while backing off (no socket exists) is a
      // true no-op — returning the same state would RE-ENTER backoff and
      // reset the pending retry timer.
      m.on(backoffState, socketClose, () => ({}));
    },
  });

  const name = (snapshot: Snapshot<ConnectionContext>) =>
    snapshot.path[0] as ConnectionStateName;

  return {
    url: () => actor.context.url,
    state: () => name(actor.snapshot()),
    isConnected: () => name(actor.snapshot()) === 'connected',
    isGaveUp: () => name(actor.snapshot()) === 'gaveUp',
    sendLoginOk: () => actor.send(loginOk.create()),
    sendLoginFail: () => actor.send(loginFail.create()),
    sendOpen: () => actor.send(socketOpen.create()),
    sendClose: () => actor.send(socketClose.create()),
    onChange(fn) {
      return actor.on('change', (snapshot) => fn(name(snapshot)));
    },
  };
}
