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
  const IPC = typeof BareKit !== 'undefined' ? BareKit.IPC : Bare.IPC;
  if (IPC && typeof IPC.resume === 'function') {
    IPC.resume();
  }
  return IPC;
}
