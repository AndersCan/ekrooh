import type { MediaKind } from './events';

/** The media kinds the native picker understands. Internal (not an `exports`
 * entry): shared by the worklet plugin and the mock transport so both reject
 * the same values. Event specs are types only, so the page can send anything. */
export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video'];

export function isMediaKind(value: unknown): value is MediaKind {
  return (MEDIA_KINDS as readonly unknown[]).includes(value);
}

/** The page-side invoke timeout for `media.pick`/`media.capture`: the native
 * picker/camera is user-mediated and can stay open for minutes. */
export const MEDIA_INVOKE_TIMEOUT_MS = 5 * 60 * 1000;

/** How long the worklet waits for the host's pick/capture. Slightly under the
 * page timeout, so a host that never answers fails the call with a
 * `HOST_ERROR` the page can read, before the page gives up on its own. */
export const MEDIA_HOST_TIMEOUT_MS = MEDIA_INVOKE_TIMEOUT_MS - 5_000;
