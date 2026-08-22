import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { safeMediaUrl } from './media-url';

describe('safeMediaUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:4321' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects empty / non-string input', () => {
    expect(safeMediaUrl('')).toBe('');
    expect(safeMediaUrl(undefined)).toBe('');
    expect(safeMediaUrl(null)).toBe('');
  });

  it('allows same-origin loopback URLs (the media server)', () => {
    expect(safeMediaUrl('http://127.0.0.1:4321/media/image-abc')).toBe(
      'http://127.0.0.1:4321/media/image-abc',
    );
  });

  it('rejects remote http(s) URLs to avoid beaconing', () => {
    expect(safeMediaUrl('https://evil.example.com/x.png')).toBe('');
    expect(safeMediaUrl('http://evil.example.com/x.png')).toBe('');
  });

  it('allows blob: URLs', () => {
    expect(safeMediaUrl('blob:http://127.0.0.1:4321/abc')).toBe(
      'blob:http://127.0.0.1:4321/abc',
    );
  });

  it('allows bounded data:image/ URLs and rejects non-image data URIs', () => {
    const small = 'data:image/png;base64,AAAA';
    expect(safeMediaUrl(small)).toBe(small);
    expect(safeMediaUrl('data:text/html;base64,AAAA')).toBe('');
  });

  it('rejects oversized data:image/ URIs', () => {
    const big = `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}`;
    expect(safeMediaUrl(big)).toBe('');
  });

  it('rejects unknown schemes', () => {
    expect(safeMediaUrl('file:///etc/passwd')).toBe('');
    expect(safeMediaUrl('javascript:alert(1)')).toBe('');
  });
});
