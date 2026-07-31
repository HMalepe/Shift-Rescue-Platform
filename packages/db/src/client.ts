import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

export type Database = ReturnType<typeof createDatabase>["db"];
export type SqlClient = ReturnType<typeof postgres>;

export interface DatabaseOptions {
  readonly url: string;
  /**
   * Pool size. Per-process — the API and each worker hold their own pool, so
   * this multiplies by process count against the RDS `max_connections`
   * ceiling. Tune both together, not independently.
   *
   * DO NOT RAISE THIS TO "FIX" SLOW BOOKING CONFIRMATIONS. It measurably makes
   * them worse. Identical k6 runs (500 VUs, 40 contended shifts, 45s):
   *
   *     pool = 10   ->  confirm p95 1.27s, min 111ms
   *     pool = 50   ->  confirm p95 1.71s, min 483ms
   *
   * The bottleneck on that path is the `FOR UPDATE` row lock, not connection
   * availability. A larger pool lets more requests grab a connection and then
   * block on the lock while *holding* it, so the queue moves from the cheap
   * place (waiting for a connection) to the expensive one (occupying a
   * database backend while idle). It also starves unrelated reads, which is
   * why proximity-browse latency degraded in the same run.
   *
   * The default of 10 stays until a measurement says otherwise. Re-run
   * `make loadtest` before changing it.
   */
  readonly maxConnections?: number;
  readonly debug?: boolean;
}

export function createDatabase(options: DatabaseOptions) {
  const client = postgres(options.url, {
    max: options.maxConnections ?? 10,

    /**
     * PostGIS `geography` columns arrive as EWKB hex and are decoded by the
     * custom type in types/geography.ts. Left as-is here so the decoding lives
     * in exactly one place.
     */
    transform: { undefined: null },

    // Fail fast rather than hanging a request behind an unavailable database;
    // the §12.2 uptime monitors need a real error to alert on.
    connect_timeout: 10,
    idle_timeout: 30,

    onnotice: options.debug ? console.warn : () => {},
  });

  const db = drizzle(client, { schema, logger: options.debug ?? false });

  return { db, client };
}
