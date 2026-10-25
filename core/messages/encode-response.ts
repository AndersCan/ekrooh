import { ErrorCode, MessageType } from './constants';
import type { MessageProtocol } from './wire-codec';
import type { PluginInvokeResponseHeader } from './types';

/** Encodes a routed response. A response that cannot be encoded (a result over
 * the 64 KB header limit, or one that does not serialize) is replaced by an
 * error response for the same request, so the caller fails fast instead of
 * waiting for a timeout that never explains why. */
export function encodeResponse(
  protocol: MessageProtocol,
  response: PluginInvokeResponseHeader,
): Uint8Array {
  try {
    return protocol.encode(MessageType.ENVELOPE, response, null);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const tooLarge = /too large/i.test(reason);
    console.error(
      `Response for ${response.pluginId}.${response.event} dropped: ${reason}`,
    );
    return protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_RESPONSE',
        pluginId: response.pluginId,
        event: response.event,
        requestId: response.requestId,
        error: {
          code: tooLarge
            ? ErrorCode.FRAME_TOO_LARGE
            : ErrorCode.INVALID_RESPONSE,
          message: `Response for ${response.pluginId}.${response.event} could not be sent: ${reason}`,
        },
      },
      null,
    );
  }
}
