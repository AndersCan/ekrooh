import { ErrorCode, MessageType } from './constants';
import { isShortId } from './frame-content';
import type { MessageProtocol } from './wire-codec';
import type { PluginInvokeResponseHeader } from './types';

/** Echoes a routing id only when it is a short string; anything else could push
 * the fallback response itself past the header cap. */
function shortId(value: unknown): string {
  return isShortId(value) ? value : '';
}

/** Encodes a routed response. A response that cannot be encoded (a result over
 * the 64 KB header limit, or one that does not serialize) is replaced by an
 * error response for the same request, so the caller fails fast instead of
 * waiting for a timeout that never explains why. The fallback carries a fixed
 * message and only short routing ids, so it always fits: this function never
 * throws. */
export function encodeResponse(
  protocol: MessageProtocol,
  response: PluginInvokeResponseHeader,
): Uint8Array {
  try {
    return protocol.encode(MessageType.ENVELOPE, response, null);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const tooLarge = /too large/i.test(reason);
    const pluginId = shortId(response.pluginId);
    const event = shortId(response.event);
    try {
      console.error(
        `Response for ${pluginId}.${event} dropped: ${reason.slice(0, 200)}`,
      );
    } catch {
      // Logging must never stop the fallback answer.
    }
    const requestId = shortId(response.requestId);
    return protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_RESPONSE',
        pluginId,
        event,
        requestId: requestId === '' ? undefined : requestId,
        error: {
          code: tooLarge
            ? ErrorCode.FRAME_TOO_LARGE
            : ErrorCode.INVALID_RESPONSE,
          message: tooLarge
            ? 'Response could not be sent: it exceeds the frame size limit'
            : 'Response could not be sent: it could not be encoded',
        },
      },
      null,
    );
  }
}
