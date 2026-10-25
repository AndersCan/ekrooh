/**
 * Internal diagnostics for the web transports. Debug logging is opt-in (off by
 * default) so an embedded library never sprays console noise into a host app's
 * devtools; genuine transport errors are surfaced consistently. Not part of
 * the public `@ekrooh/bare` contract — exposed only so a dev shell can opt in.
 */

let debugEnabled = false;

/** Opt in to verbose transport debug logging (e.g. from a dev shell). */
export function setTransportDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function logTransportDebug(message: string): void {
  if (debugEnabled) console.debug(message);
}

export function logTransportError(message: string, error?: unknown): void {
  if (error !== undefined) console.error(message, error);
  else console.error(message);
}
