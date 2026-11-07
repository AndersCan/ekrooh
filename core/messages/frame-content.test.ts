import { describe, expect, it } from 'vite-plus/test';
import { ErrorCode } from './constants';
import {
  FrameContentError,
  isShortId,
  MAX_ID_LENGTH,
  utf8ByteLength,
} from './frame-content';
import { CoreError } from './types';

describe('FrameContentError', () => {
  it('is a FRAME_INVALID CoreError that carries the recovered routing fields', () => {
    const err = new FrameContentError('bad', {
      type: 'INVOKE_REQUEST',
      requestId: 'r1',
    });
    expect(err).toBeInstanceOf(CoreError);
    expect(err.code).toBe(ErrorCode.FRAME_INVALID);
    expect(err.name).toBe('FrameContentError');
    expect(err.recovered).toEqual({ type: 'INVOKE_REQUEST', requestId: 'r1' });
    expect(new FrameContentError('bad').recovered).toBeUndefined();
  });

  it('bounds ids at 256 characters, like the Kotlin host', () => {
    expect(MAX_ID_LENGTH).toBe(256);
  });

  it('measures UTF-8 bytes the way an encoder writes them (adv-B-6)', () => {
    const enc = new TextEncoder();
    for (const str of [
      '',
      'abc',
      'é',
      '€',
      '😀',
      'a😀é€',
      '\uD800',
      'x\uDC00y',
    ]) {
      expect(utf8ByteLength(str)).toBe(enc.encode(str).byteLength);
    }
    expect(isShortId('é'.repeat(128))).toBe(true);
    expect(isShortId('é'.repeat(129))).toBe(false);
    expect(isShortId('a'.repeat(256))).toBe(true);
    expect(isShortId('a'.repeat(257))).toBe(false);
    expect(isShortId(42)).toBe(false);
  });
});
