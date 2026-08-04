import { defineConfig } from "vitest/config";
import { testDatabaseUrl } from "../../scripts/test-db-url.mjs";

export default defineConfig({
  test: {
    /*
     * This package's own database. Packages share one Postgres server and used
     * to share one database, which made the §4.4 drain gates claim each
     * other's rows — see scripts/test-dbs.sh for the full diagnosis.
     */
    env: { DATABASE_URL: testDatabaseUrl("core") },
    // Gate tests contend on real Postgres rows on purpose. Running files in
    // parallel would have separate scenarios interleave in ways that make a
    // failure ambiguous, so files run serially; concurrency under test comes
    // from Promise.all inside each test, not from the runner.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
