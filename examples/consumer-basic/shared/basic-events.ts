import {
  EventSpec,
  InvokeEnvelope,
  PluginDispatchHeader,
  invokeEvent,
} from '@ekrooh/bare/core';

/**
 * The consumer plugin's event contract — one `EventSpec` per event, shared by
 * the worklet (defines the manifest + handlers via `definePlugin`) and the web
 * layer (typed builders). See docs consumers/authoring-plugins.mdx.
 */
export const basicSpecs = {
  /** One invoke: web → worklet request/response. */
  ping: {
    pluginId: 'app.basic',
    name: 'basic.ping',
    args: {} as { message?: string },
    result: {} as { message: string; ts: number },
  },
  /** One backend → web push, dispatched by the worklet (no requestId). */
  beep: {
    pluginId: 'app.basic',
    name: 'basic.beep',
    args: {} as { count: number },
    result: {} as Record<string, never>,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const basicEvents = {
  ping(
    message = 'ping',
  ): InvokeEnvelope<
    'basic.ping',
    { message?: string },
    { message: string; ts: number }
  > {
    return invokeEvent(basicSpecs.ping, { message });
  },
};

/** The backend → web push header for `basic.beep`, built from the same spec so
 * the wire event name and args can never drift from the web-side matcher. */
export function basicBeepHeader(count: number): PluginDispatchHeader {
  return {
    type: 'DISPATCH',
    pluginId: basicSpecs.beep.pluginId,
    event: basicSpecs.beep.name,
    args: { count },
  };
}
