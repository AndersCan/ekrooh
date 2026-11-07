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
 *
 * - The retry cap only applies to a client that has never connected, and only
 *   once the boot window (`minBootWindowMs`) has passed, so unlucky jitter can
 *   never give up in a few milliseconds. Once a socket has opened, a lost
 *   connection retries forever at the capped backoff (the app may simply be
 *   suspended), and `WAKE` skips the wait when it returns.
 * - `retries` is only reset once a socket has stayed open for `stableMs`: a
 *   socket that opens and is dropped at once keeps backing off exponentially
 *   instead of reconnecting in a tight loop.
 * - A socket the server replaced (close code 4001, another document took the
 *   session) waits `replacedBackoffMs` or a `WAKE` — two documents must not
 *   evict each other forever.
 * - `gaveUp` is not final: `WAKE` returns to `idle` so the shell can log in
 *   and connect again.
 * - `CLOSE` (the transport was closed) is final from every state.
 *
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
  /** Returns a float in [0, 1) used to randomize the backoff delay (equal
   * jitter: half fixed, half random), so many WebViews do not reconnect in
   * lockstep. Defaults to `Math.random`. Inject a deterministic source in
   * tests. */
  random?: () => number;
  /** A never-connected client gives up only once this long (ms) has passed
   * since its first attempt, whatever the retry count. Default 10s. */
  minBootWindowMs?: number;
  /** How long (ms) a socket must stay open before the retry count resets.
   * Default 5s. */
  stableMs?: number;
  /** How long (ms) to wait after the server replaced the socket (close code
   * 4001) before reconnecting, unless `WAKE` arrives first. Default 30s. */
  replacedBackoffMs?: number;
  /** How long (ms) a socket may stay in `opening` before it is treated as
   * failed. Default 10s. */
  openTimeoutMs?: number;
}

export type ConnectionStateName =
  | 'idle'
  | 'opening'
  | 'connected'
  | 'backoff'
  | 'gaveUp'
  | 'closed';

const DEFAULT_MIN_BOOT_WINDOW_MS = 10_000;
const DEFAULT_STABLE_MS = 5_000;
const DEFAULT_REPLACED_BACKOFF_MS = 30_000;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;

const idleState = state('idle')();
const openingState = state('opening')();
const connectedState = state('connected')();
const backoffState = state('backoff')();
const gaveUpState = state('gaveUp')();
const closedState = state('closed')().final();

const loginOk = event('LOGIN_OK')();
const loginFail = event('LOGIN_FAIL')();
const socketOpen = event('SOCKET_OPEN')();
const socketClose = event('SOCKET_CLOSE')();
const socketReplaced = event('SOCKET_REPLACED')();
const wake = event('WAKE')();
const close = event('CLOSE')();
const retryTimer = event('RETRY_TIMER')();
const stableTimer = event('STABLE_TIMER')();
const openTimeout = event('OPEN_TIMEOUT')();

type ConnectionContext = {
  url: string;
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  retries: number;
  /** Set on the first `SOCKET_OPEN`; lifts the retry cap for good. */
  everConnected: boolean;
  /** Clock time of the first attempt in the current boot window. */
  bootStartedAt: number;
  /** The last close was a server-side replacement (close code 4001). */
  replaced: boolean;
};

export interface ConnectionMachine {
  url(): string;
  state(): ConnectionStateName;
  isConnected(): boolean;
  isGaveUp(): boolean;
  isClosed(): boolean;
  /** True while another document holds the session (the server replaced
   * this socket) and the client is waiting before it takes it back. */
  isReplaced(): boolean;
  /** True once a client that has connected before has failed more than
   * `maxRetries` times in a row and is not connected: the outage is no
   * longer a quick blip. */
  isDegraded(): boolean;
  sendLoginOk(): void;
  sendLoginFail(): void;
  sendOpen(): void;
  sendClose(): void;
  /** The server replaced this socket (close code 4001). */
  sendReplaced(): void;
  /** The app returned to the foreground: retry now rather than after the
   * backoff, or start over after a give-up. A no-op in every other state. */
  sendWake(): void;
  /** The transport was closed for good. */
  sendStop(): void;
  /** Fires on every state/context change with the current state name. */
  onChange(fn: (state: ConnectionStateName) => void): () => void;
}

export function createConnectionMachine(
  options: ConnectionMachineOptions,
): ConnectionMachine {
  const clockImpl = options.clock ?? new RealClock();
  const minBootWindowMs = options.minBootWindowMs ?? DEFAULT_MIN_BOOT_WINDOW_MS;
  const stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
  const replacedBackoffMs =
    options.replacedBackoffMs ?? DEFAULT_REPLACED_BACKOFF_MS;
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const random = options.random ?? Math.random;

  const context: ConnectionContext = {
    url: options.url,
    maxRetries: options.maxRetries,
    initialBackoffMs: options.initialBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
    retries: 0,
    everConnected: false,
    bootStartedAt: 0,
    replaced: false,
  };

  const actor = new Actor({
    inputs: [
      loginOk,
      loginFail,
      socketOpen,
      socketClose,
      socketReplaced,
      wake,
      close,
    ],
    internal: [retryTimer, stableTimer, openTimeout],
    outputs: [],
    states: [
      idleState,
      openingState,
      connectedState,
      backoffState,
      gaveUpState,
      closedState,
    ],
    initial: idleState,
    clock: clockImpl,
    context,
    setup: (m) => {
      m.effect(backoffState, ({ signal, context, clock, emit }) => {
        const s = context.get();
        let delay: number;
        if (s.replaced) {
          delay = replacedBackoffMs;
        } else {
          const capped = Math.min(
            s.initialBackoffMs * 2 ** (s.retries - 1),
            s.maxBackoffMs,
          );
          // Equal jitter: half the capped delay is fixed, half is random, so
          // clients spread out but no retry ever fires at ~0ms.
          const r = Math.max(0, Math.min(1, random()));
          delay = Math.floor(capped / 2 + (capped / 2) * r);
        }
        clock.setTimeout(
          delay,
          () => {
            if (signal.aborted) return;
            emit({ type: 'RETRY_TIMER' });
          },
          { signal },
        );
      });
      m.effect(connectedState, ({ signal, clock, emit }) => {
        clock.setTimeout(
          stableMs,
          () => {
            if (signal.aborted) return;
            emit({ type: 'STABLE_TIMER' });
          },
          { signal },
        );
      });
      m.effect(openingState, ({ signal, clock, emit }) => {
        clock.setTimeout(
          openTimeoutMs,
          () => {
            if (signal.aborted) return;
            emit({ type: 'OPEN_TIMEOUT' });
          },
          { signal },
        );
      });

      m.on(idleState, loginOk, (_event, opts) => {
        const s = opts!.context.get();
        opts!.context.set({ ...s, bootStartedAt: clockImpl.now() });
        return { state: openingState };
      });
      // A failed login has no token-URL fallback: fail the queue (the shell
      // never opens a socket) rather than transitioning to a state that would
      // flush queued requests. `WAKE` may start over later.
      m.on(idleState, loginFail, () => ({ state: gaveUpState }));

      m.on(openingState, socketOpen, (_event, opts) => {
        const s = opts!.context.get();
        // `retries` is not reset here: only a socket that stays open for
        // `stableMs` proves the connection is healthy again.
        opts!.context.set({ ...s, everConnected: true, replaced: false });
        return { state: connectedState };
      });
      const openFailed = (ctx: {
        get(): ConnectionContext;
        set(next: ConnectionContext): void;
      }) => {
        const s = ctx.get();
        // A close while still `opening` means the upgrade was rejected and the
        // `/login` cookie did not ride the handshake. There is no token-URL
        // fallback — retry (or give up at the cap) on a fresh socket instead.
        if (
          !s.everConnected &&
          s.retries >= s.maxRetries &&
          clockImpl.now() - s.bootStartedAt >= minBootWindowMs
        ) {
          return { state: gaveUpState };
        }
        ctx.set({ ...s, retries: s.retries + 1, replaced: false });
        return { state: backoffState };
      };
      m.on(openingState, socketClose, (_e, opts) => openFailed(opts!.context));
      m.on(openingState, openTimeout, (_e, opts) => openFailed(opts!.context));
      m.on(openingState, socketReplaced, (_e, opts) =>
        openFailed(opts!.context),
      );

      m.on(connectedState, stableTimer, (_event, opts) => {
        const s = opts!.context.get();
        opts!.context.set({ ...s, retries: 0 });
        return {};
      });
      m.on(connectedState, socketClose, (_event, opts) => {
        const s = opts!.context.get();
        opts!.context.set({ ...s, retries: s.retries + 1, replaced: false });
        return { state: backoffState };
      });
      m.on(connectedState, socketReplaced, (_event, opts) => {
        const s = opts!.context.get();
        opts!.context.set({ ...s, retries: 0, replaced: true });
        return { state: backoffState };
      });
      m.on(backoffState, retryTimer, () => ({ state: openingState }));
      m.on(backoffState, wake, () => ({ state: openingState }));
      // Defensive: a stray close while backing off (no socket exists) is a
      // true no-op — returning the same state would RE-ENTER backoff and
      // reset the pending retry timer.
      m.on(backoffState, socketClose, () => ({}));
      m.on(backoffState, socketReplaced, () => ({}));
      m.on(gaveUpState, wake, (_event, opts) => {
        const s = opts!.context.get();
        opts!.context.set({ ...s, retries: 0, replaced: false });
        return { state: idleState };
      });

      for (const from of [
        idleState,
        openingState,
        connectedState,
        backoffState,
        gaveUpState,
      ]) {
        m.on(from, close, () => ({ state: closedState }));
      }
    },
  });

  const name = (snapshot: Snapshot<ConnectionContext>) =>
    snapshot.path[0] as ConnectionStateName;
  const current = () => name(actor.snapshot());

  return {
    url: () => actor.context.url,
    state: current,
    isConnected: () => current() === 'connected',
    isGaveUp: () => current() === 'gaveUp',
    isClosed: () => current() === 'closed',
    isReplaced: () => current() === 'backoff' && actor.context.replaced,
    isDegraded: () =>
      current() !== 'connected' &&
      actor.context.everConnected &&
      actor.context.retries > actor.context.maxRetries,
    sendLoginOk: () => actor.send(loginOk.create()),
    sendLoginFail: () => actor.send(loginFail.create()),
    sendOpen: () => actor.send(socketOpen.create()),
    sendClose: () => actor.send(socketClose.create()),
    sendReplaced: () => actor.send(socketReplaced.create()),
    sendWake: () => actor.send(wake.create()),
    sendStop: () => actor.send(close.create()),
    onChange(fn) {
      return actor.on('change', (snapshot) => fn(name(snapshot)));
    },
  };
}
