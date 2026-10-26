/**
 * @fileoverview Bare IPC provider for Android (BareKit) and Sidecar (Bare.IPC)
 */

interface BareIPC extends NodeJS.EventEmitter {
  read(n?: number): Buffer | null;
  write(data: Uint8Array | string): boolean;
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
 * Returns the active IPC channel, or null when there is no host.
 * In BareKit (Android, iOS), it uses BareKit.IPC.
 * In Bare (Sidecar), it uses Bare.IPC.
 */
export function getIPC(): BareIPC | null {
  // `typeof BareKit !== 'undefined'` guards BareKit (Android); when neither
  // exists (plain Node / bare CLI without a host) `Bare.IPC` must not throw —
  // the runtime treats a missing IPC as "no host".
  const IPC =
    typeof BareKit !== 'undefined'
      ? BareKit.IPC
      : typeof Bare !== 'undefined'
        ? Bare.IPC
        : undefined;
  if (IPC && typeof IPC.resume === 'function') {
    IPC.resume();
  }
  return IPC ?? null;
}
