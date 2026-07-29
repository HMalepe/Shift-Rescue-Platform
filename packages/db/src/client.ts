import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

export type Database = ReturnType<typeof createDatabase>["db"];
export type SqlClient = ReturnType<typeof postgres>;

export interface DatabaseOptions {
  readonly url: string;
  /**
   * Pool size. The default of 10 is per-process — the API and each worker hold
   * their own pool, so this multiplies by process count against the RDS
   * `max_connections` ceiling. Tune both together, not independently.
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
