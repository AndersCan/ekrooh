/** Types for `scripts/api-snapshot.mjs` (imported by `contract.test.ts`). */
export declare const SNAPSHOT_PATH: string;
export declare const UPDATE_COMMAND: string;
export declare function stripComments(source: string): string;
export declare function normalizeDeclaration(source: string): string;
export declare function buildApiSnapshot(distDir?: string): string;
