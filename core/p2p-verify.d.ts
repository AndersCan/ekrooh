/**
 * Ambient types for the consumer-side p2p stack, imported only by the dev
 * verification worklet (`core/p2p-verify.core.ts`). The JS packages ship no
 * TypeScript declarations; the worklet is dev tooling, not public surface.
 * Not part of the package build or the public exports map.
 */
declare module 'corestore';
declare module 'hyperdrive';
declare module 'hyperswarm';
declare module 'hyperdht';
declare module 'udx-native';
