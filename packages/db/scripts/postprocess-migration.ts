/**
 * Post-processes drizzle-kit output.
 *
 * Run automatically by `pnpm --filter @locum/db generate`. Idempotent: running
 * it twice over the same file is a no-op, so it is safe in CI and safe to
 * re-run by hand.
 *
 * Three things drizzle-kit cannot express, all of which matter:
 *
 * 1. PostGIS column types. drizzle-kit treats any type it does not recognise as
 *    a quoted identifier, emitting `"geography(Point, 4326)"`. Postgres then
 *    looks for a type *literally named* that, and the migration fails. There is
 *    no hook to opt out of the quoting, so it is stripped here.
 *
 * 2. `CREATE EXTENSION`. The schema DSL has no concept of extensions, but
 *    postgis and pgcrypto must exist before the first table referencing them.
 *
 * 3. CHECK constraints. §12.5 states a gate cannot move to `passed` without a
 *    non-null evidence_url. Enforcing that in application code only would mean
 *    the rule is exactly as reliable as the one code path that writes the row —
 *    which is the failure mode §12.5 exists to prevent.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

const EXTENSIONS_PREAMBLE = `-- Added by scripts/postprocess-migration.ts (see that file for why).
-- PostGIS backs every proximity query; pgcrypto backs gen_random_uuid().
CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
`;

const EVIDENCE_CHECK = `--> statement-breakpoint
-- §12.5: "A gate cannot move to \`passed\` without a non-null evidence_url."
-- Enforced by the database so it holds regardless of which code path writes.
ALTER TABLE "verification_runs"
  ADD CONSTRAINT "verification_runs_passed_requires_evidence"
  CHECK ("status" <> 'passed' OR "evidence_url" IS NOT NULL);`;

/** §9 / §10.0 — money is integer cents and is never negative. */
const MONEY_CHECKS = `--> statement-breakpoint
ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_hourly_rate_non_negative"
  CHECK ("hourly_rate_cents" >= 0);--> statement-breakpoint
ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_ends_after_starts"
  CHECK ("ends_at" > "starts_at");--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_monthly_non_negative"
  CHECK ("monthly_cents" >= 0);--> statement-breakpoint
-- §7 reputation is a 1-5 star score.
ALTER TABLE "ratings"
  ADD CONSTRAINT "ratings_score_range"
  CHECK ("score" BETWEEN 1 AND 5);--> statement-breakpoint
-- §10.1 — a radius shift must actually carry a radius.
ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_radius_required_when_radius_visibility"
  CHECK ("visibility" <> 'radius' OR "radius_km" IS NOT NULL);`;

function postprocess(path: string): boolean {
  const original = readFileSync(path, "utf8");
  let sql = original;

  // (1) Unquote PostGIS types: "geography(Point, 4326)" -> geography(Point, 4326)
  sql = sql.replace(/"(geography\([^"]*\))"/g, "$1");

  // (2) Extensions must precede everything that uses them.
  if (!sql.includes("CREATE EXTENSION IF NOT EXISTS postgis")) {
    sql = EXTENSIONS_PREAMBLE + sql;
  }

  // (3) CHECK constraints, appended once the tables exist.
  if (!sql.includes("verification_runs_passed_requires_evidence")) {
    sql = sql.trimEnd() + EVIDENCE_CHECK;
  }
  if (!sql.includes("shifts_hourly_rate_non_negative")) {
    sql = sql.trimEnd() + MONEY_CHECKS;
  }

  if (sql !== original) {
    writeFileSync(path, sql.trimEnd() + "\n");
    return true;
  }
  return false;
}

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
let changed = 0;
for (const file of files) {
  if (postprocess(join(MIGRATIONS_DIR, file))) {
    console.log(`  postprocessed ${file}`);
    changed += 1;
  }
}
console.log(
  changed === 0
    ? "migrations already postprocessed (no changes)"
    : `postprocessed ${changed} migration file(s)`,
);
