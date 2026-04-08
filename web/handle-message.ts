import { WireMessage } from '../core/messages';

export function handleMessage(msg: WireMessage) {
  if (msg.header.type === 'INVOKE_RESPONSE' && msg.header.error) {
    console.error(
      'Plugin invoke failed:',
      msg.header.pluginId,
      msg.header.event,
      msg.header.error.message,
    );
  }
}
