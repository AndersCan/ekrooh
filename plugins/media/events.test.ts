import { describe, expect, it } from 'vite-plus/test';
import { mediaEvents, mediaSpecs } from './events';

describe('mediaEvents builders', () => {
  it('pick defaults to image and uses the long invoke timeout', () => {
    expect(mediaEvents.media.pick()).toMatchObject({
      kind: 'invoke',
      pluginId: 'vendor.media',
      event: 'media.pick',
      args: { kind: 'image' },
      timeoutMs: 300000,
    });
  });

  it('pick carries the requested kind', () => {
    expect(mediaEvents.media.pick('video').args).toEqual({ kind: 'video' });
  });

  it('capture builds the capture invoke envelope', () => {
    expect(mediaEvents.media.capture()).toMatchObject({
      event: 'media.capture',
      args: { kind: 'image' },
      timeoutMs: 300000,
    });
  });

  it('specs pin the wire event names', () => {
    expect(Object.values(mediaSpecs).map((s) => s.name)).toEqual([
      'media.pick',
      'media.capture',
    ]);
  });
});
