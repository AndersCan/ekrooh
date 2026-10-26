/** Normalizes a binary stream chunk to a `Uint8Array` view without copying.
 * A `Buffer` is already a `Uint8Array`. Anything else (a text WebSocket
 * message, a stray object) is not a protocol frame and throws. */
export function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError(
    `expected binary data, got ${data === null ? 'null' : typeof data}`,
  );
}

/** The chunk form Bare's IPC stream writes: a `Buffer` view over the same
 * memory where `Buffer` exists (on Bare `encode` already returns one), the
 * bytes themselves elsewhere. */
export function toIpcChunk(bytes: Uint8Array): Uint8Array {
  if (typeof Buffer === 'undefined' || Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
