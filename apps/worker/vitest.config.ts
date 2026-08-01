import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Same reasoning as packages/core: these tests contend on real Postgres
    // rows and a real Redis, and interleaved files make a failure ambiguous.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
