/** Types for `scripts/api-snapshot.mjs` (imported by `contract.test.ts`). */
export declare const SNAPSHOT_PATH: string;
export declare const UPDATE_COMMAND: string;
export declare function stripComments(source: string): string;
export declare function chunkExportMap(source: string): Map<string, string>;
export declare function normalizeDeclaration(
  source: string,
  options?: {
    /** An `exports` entry file (its export list is kept verbatim). */
    isEntry?: boolean;
    /** Chunk specifier (`./index-HASH.mjs`) -> that chunk's export map. */
    chunkExports?: Map<string, Map<string, string>>;
  },
): string;
export declare function buildApiSnapshot(distDir?: string): string;
