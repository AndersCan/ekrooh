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

  it('never throws or echoes when the routing ids alone overflow the header (C-3)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const long = 'e'.repeat(40_000);
    const frame = encodeResponse(protocol, {
      type: 'INVOKE_RESPONSE',
      pluginId: 'app.big',
      event: long,
      requestId: long,
      error: { code: 'UNSUPPORTED_EVENT', message: long },
    });
    const header = protocol.decode(frame).header as PluginInvokeResponseHeader;
    expect(header.error?.code).toBe('FRAME_TOO_LARGE');
    expect(header.event).toBe('');
    expect(header.requestId).toBeUndefined();
    expect(header.error?.message).not.toContain('eeee');
  });
});
