import { EventSpec, invokeEvent, InvokeEnvelope } from '../../core/messages';

export type MediaKind = 'image' | 'video';

export type MediaResult = {
  /** URL served by the worklet's loopback HTTP server (no bytes on the wire). */
  url: string;
  /** Absolute filesystem path of the picked file on the host. */
  path: string;
};

// The native picker/camera is user-mediated and can stay open for minutes;
// never let the invoke timeout (default 5s) abort it.
const MEDIA_INVOKE_TIMEOUT_MS = 5 * 60 * 1000;

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
      return invokeEvent(
        mediaSpecs.pick,
        { kind },
        null,
        MEDIA_INVOKE_TIMEOUT_MS,
      );
    },
    capture(
      kind: MediaKind = 'image',
    ): InvokeEnvelope<'media.capture', { kind?: MediaKind }, MediaResult> {
      return invokeEvent(
        mediaSpecs.capture,
        { kind },
        null,
        MEDIA_INVOKE_TIMEOUT_MS,
      );
    },
  },
};
