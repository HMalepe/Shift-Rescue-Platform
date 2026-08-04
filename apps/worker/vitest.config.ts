import { defineConfig } from "vitest/config";
import { testDatabaseUrl } from "../../scripts/test-db-url.mjs";

export default defineConfig({
  test: {
    /*
     * This package's own database. Packages share one Postgres server and used
     * to share one database, which made the §4.4 drain gates claim each
     * other's rows — see scripts/test-dbs.sh for the full diagnosis.
     */
    env: { DATABASE_URL: testDatabaseUrl("worker") },
    // Same reasoning as packages/core: these tests contend on real Postgres
    // rows and a real Redis, and interleaved files make a failure ambiguous.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
