/**
 * Picks the database a package's tests run against.
 *
 * Each package that touches Postgres gets its own, created by
 * `scripts/test-dbs.sh`. The reason is in that script's header: turbo runs
 * packages in parallel, `claimDueMessages` claims whatever is due by design,
 * and the worker's seam test makes everything due — so packages were claiming
 * each other's rows and failing about one run in three.
 *
 * `DATABASE_URL` still wins when it is set explicitly, so a developer pointing
 * a single package at a scratch database, or CI supplying its own, keeps
 * working. The per-package database is the default, not a mandate.
 */
export function testDatabaseUrl(packageName) {
  const explicit = process.env["DATABASE_URL"];
  if (explicit && process.env["TEST_DB_PER_PACKAGE"] === "false") return explicit;

  const base =
    process.env["TEST_DB_BASE"] ?? "postgresql://locum:locum_local_dev@localhost:5432";
  return `${base}/locum_test_${packageName}`;
}
