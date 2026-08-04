import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Gate tests contend on real Postgres rows on purpose. Running files in
    // parallel would have separate scenarios interleave in ways that make a
    // failure ambiguous, so files run serially; concurrency under test comes
    // from Promise.all inside each test, not from the runner.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
