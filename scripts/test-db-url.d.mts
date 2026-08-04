/**
 * Types for `test-db-url.mjs`.
 *
 * Kept as plain JS plus a declaration rather than TypeScript because it is
 * imported from four `vitest.config.ts` files that live in four different
 * packages, none of which has this directory in its `rootDir` — a `.ts` here
 * would compile under whichever package happened to reach it first.
 */
export declare function testDatabaseUrl(packageName: string): string;
