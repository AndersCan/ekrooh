import { EventSpec, invokeEvent, InvokeEnvelope } from '../../core/messages';

export type MediaKind = 'image' | 'video';

export type MediaResult = {
  /** URL served by the worklet's loopback HTTP server (no bytes on the wire). */
  url: string;
  /** Absolute filesystem path of the picked file on the host. */
  path: string;
};

export const mediaSpecs = {
  pick: {
    pluginId: 'vendor.media',
    name: 'media.pick',
    args: {} as { kind?: MediaKind },
    result: {} as MediaResult,
  },
  capture: {
    pluginId: 'vendor.media',
    name: 'media.capture',
    args: {} as { kind?: MediaKind },
    result: {} as MediaResult,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const mediaEvents = {
  media: {
    pick(
      kind: MediaKind = 'image',
    ): InvokeEnvelope<'media.pick', { kind?: MediaKind }, MediaResult> {
      return invokeEvent(mediaSpecs.pick, { kind });
    },
    capture(
      kind: MediaKind = 'image',
    ): InvokeEnvelope<'media.capture', { kind?: MediaKind }, MediaResult> {
      return invokeEvent(mediaSpecs.capture, { kind });
    },
  },
};
