/**
 * @fileoverview Bare IPC provider for Android (BareKit) and Sidecar (Bare.IPC)
 */

interface BareIPC extends NodeJS.EventEmitter {
  read(n?: number): Buffer | null;
  write(data: Buffer | string): boolean;
  resume?(): void;
  pause?(): void;
}

interface BareKitGlobal {
  IPC: BareIPC;
}

interface BareGlobal {
  IPC: BareIPC;
}

declare const BareKit: BareKitGlobal | undefined;
declare const Bare: BareGlobal;

/**
 * Returns the active IPC channel.
 * In BareKit (Android), it uses BareKit.IPC.
 * In Bare (Sidecar), it uses Bare.IPC.
 */
export function getIPC(): BareIPC {
  // `typeof BareKit !== 'undefined'` guards BareKit (Android); when neither
  // exists (plain Node / bare CLI without a host) `Bare.IPC` must not throw —
  // the runtime treats a missing IPC as "no host" (dev mode).
  const IPC =
    typeof BareKit !== 'undefined'
      ? BareKit.IPC
      : typeof Bare !== 'undefined'
        ? Bare.IPC
        : undefined;
  if (IPC && typeof IPC.resume === 'function') {
    IPC.resume();
  }
  return IPC as BareIPC;
}
