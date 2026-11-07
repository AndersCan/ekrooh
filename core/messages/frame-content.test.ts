import { describe, expect, it } from 'vite-plus/test';
import { ErrorCode } from './constants';
import { FrameContentError, MAX_ID_LENGTH } from './frame-content';
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
});
