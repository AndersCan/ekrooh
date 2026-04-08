import { CoreError, Either, PluginManifest } from '../../core/messages';

function ok<T>(result: T): Either<CoreError, T> {
  return [null, result];
}

function err(code: string, message: string): Either<CoreError, never> {
  return [new CoreError(code, message), null];
}

export function createHealthPlugin(): PluginManifest {
  return {
    id: 'core.health',
    runtimes: {
      bare: {
        invoke: (event, args, context) => {
          if (event === 'health.ping') {
            return ok({
              message: String(args?.message ?? 'pong'),
              ts: Date.now(),
            });
          }
          if (event === 'health.payloadEcho') {
            return ok({
              label: String(args?.label ?? 'payload'),
              payloadSize: context.payload.byteLength,
            });
          }
          if (event === 'health.roundtrip') {
            return ok({ pong: true, ts: Date.now() });
          }
          return err('UNSUPPORTED_EVENT', `Unsupported event ${event}`);
        },
      },
    },
  };
}
