import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { join } from "node:path";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

/**
 * Migrations run on a dedicated single connection with `max: 1`.
 *
 * Drizzle wraps the run in a transaction and takes an advisory lock, but a
 * pooled client can hand different statements to different backends, which
 * breaks both. One connection makes the whole run genuinely serial — which
 * matters the first time two ECS tasks boot simultaneously after a deploy.
 */
const client = postgres(url, { max: 1, onnotice: () => {} });

try {
  const started = Date.now();
  await migrate(drizzle(client), {
    migrationsFolder: join(import.meta.dirname, "..", "migrations"),
  });
  console.log(`migrations applied in ${Date.now() - started}ms`);
} catch (error) {
  console.error("migration failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
