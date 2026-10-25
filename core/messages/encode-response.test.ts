import { describe, expect, it, vi } from 'vite-plus/test';
import { encodeResponse } from './encode-response';
import { MessageProtocol } from './wire-codec';
import type { PluginInvokeResponseHeader } from './types';

const protocol = new MessageProtocol();
const base = {
  type: 'INVOKE_RESPONSE',
  pluginId: 'app.big',
  event: 'big',
  requestId: 'r1',
} as const;

function decode(response: PluginInvokeResponseHeader) {
  return protocol.decode(encodeResponse(protocol, response))
    .header as PluginInvokeResponseHeader;
}

describe('encodeResponse', () => {
  it('encodes a response that fits unchanged', () => {
    expect(decode({ ...base, result: { ok: true } }).result).toEqual({
      ok: true,
    });
  });

  it('replaces an over-limit result with FRAME_TOO_LARGE for the same request', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const header = decode({ ...base, result: { text: 'x'.repeat(70_000) } });
    expect(header.requestId).toBe('r1');
    expect(header.result).toBeUndefined();
    expect(header.error?.code).toBe('FRAME_TOO_LARGE');
  });

  it('replaces an unserializable result with INVALID_RESPONSE', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const header = decode({ ...base, result: { n: BigInt(1) } });
    expect(header.requestId).toBe('r1');
    expect(header.error?.code).toBe('INVALID_RESPONSE');
  });
});
