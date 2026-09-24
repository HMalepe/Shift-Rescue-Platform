#!/usr/bin/env node
// Bundles a Node ESM entrypoint with esbuild, for apps/api and apps/worker.
//
// Shared rather than duplicated per app: the external list below is the
// entire safety argument for this build ("do not bundle a native module, do
// not bundle a package whose own internals assume it is resolved as a real
// node_modules package"), and two copies of that list drifting apart is
// exactly how one app silently regains the bug the other was fixed for.
//
// Usage: node scripts/build-node-app.mjs <entry> <outfile>
import { build } from "esbuild";

/*
 * Never bundled. Two different reasons, both fatal if ignored:
 *
 *   - Native binaries. @node-rs/argon2 ships a prebuilt .node file selected
 *     per-platform at require() time (see packages/core/src/auth/
 *     password.ts's own comment). esbuild cannot inline a native addon —
 *     bundling this either throws at build time or, worse, produces a
 *     bundle that builds fine and crashes the moment login is called.
 *
 *   - Packages whose own internals assume they are resolved as a real
 *     node_modules package rather than inlined into someone else's bundle:
 *     postgres (dynamic requires for its native extension), bullmq/ioredis
 *     (their own internal dynamic requires), pino (transport workers spawned
 *     from pino's own package directory — a bundled pino cannot find them),
 *     drizzle-orm (dialect drivers are conditionally required based on which
 *     database is in use), and fastify plus its official plugins bundle
 *     their own plugin-metadata machinery (fastify-plugin's encapsulation
 *     checks) that gets confused by seeing itself re-exported from a
 *     different module identity than the one Node actually loaded.
 *
 * All of these stay real npm dependencies, present in the runtime image's
 * node_modules, resolved by Node exactly the way they always were — only the
 * workspace's OWN code (apps/api, apps/worker, packages/core, packages/db,
 * packages/integrations, packages/observability) gets inlined into one file.
 */
const EXTERNAL = [
  "@node-rs/argon2",
  "postgres",
  "bullmq",
  "ioredis",
  "pino",
  "drizzle-orm",
  "fastify",
  "@fastify/formbody",
  "@fastify/rate-limit",
  "fastify-plugin",
];

const [, , entry, outfile] = process.argv;
if (!entry || !outfile) {
  console.error("usage: node scripts/build-node-app.mjs <entry> <outfile>");
  process.exit(1);
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // Workspace packages resolve through their package.json "exports" field
  // straight to TypeScript source (e.g. "@locum/core" -> "./src/index.ts") —
  // esbuild transpiles that directly; only packages/*'s own devDependency on
  // `typescript` runs a real type check (via each package's own `typecheck`
  // script), this step does not.
  external: EXTERNAL,
  logLevel: "info",
  metafile: false,
});
