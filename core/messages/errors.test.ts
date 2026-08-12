import { describe, expect, it } from 'vite-plus/test';
import { coerceErrorCode, err, ok } from './errors';
import { CoreError } from './types';
import { ErrorCode } from './constants';

describe('Either result helpers', () => {
  it('ok wraps a value in the success half', () => {
    expect(ok(42)).toEqual([null, 42]);
  });

  it('err builds a canonical CoreError failure', () => {
    const [error, value] = err(ErrorCode.HOST_ERROR, 'boom');
    expect(value).toBeNull();
    expect(error).toBeInstanceOf(CoreError);
    expect(error.code).toBe('HOST_ERROR');
    expect(error.message).toBe('boom');
  });

  it('coerceErrorCode preserves known wire codes', () => {
    expect(coerceErrorCode('UNSUPPORTED_EVENT')).toBe('UNSUPPORTED_EVENT');
    expect(coerceErrorCode('HOST_ERROR')).toBe('HOST_ERROR');
  });

  it('coerceErrorCode maps unknown or missing codes to PLUGIN_ERROR', () => {
    expect(coerceErrorCode('NOPE')).toBe('PLUGIN_ERROR');
    expect(coerceErrorCode(undefined)).toBe('PLUGIN_ERROR');
  });
});
