import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/client";
import { verificationRuns } from "../src/schema/platform";
import type { GateClock, GateStatus } from "../src/schema/enums";

/**
 * Reconstructs the §12.5 gate ledger in `verification_runs` from gates.json.
 *
 * Run by `make gates`, and after `make reset` — the ledger is durable data,
 * but the *dev* database is disposable, and the two were previously the same
 * thing. Dropping the local database to test a migration silently erased every
 * gate row, which is the failure §12.5 describes arriving through the back
 * door.
 *
 * Deliberately additive: each run inserts a new row rather than updating an
 * existing one, because the ledger is a history of executions and not a status
 * board. "This gate passed on the 3rd and again on the 11th" is the useful
 * shape; "this gate is currently green" throws away the part that lets you ask
 * when it stopped being green.
 */

interface GateEntry {
  readonly gateId: string;
  /** Kept in step with the pgEnum rather than restated, so a new status in
   * the schema is a compile error here instead of a runtime constraint
   * violation halfway through recording the ledger. */
  readonly clock: GateClock;
  readonly status: GateStatus;
  readonly evidenceUrl?: string | null;
  readonly executedBy?: string;
  readonly notes?: string;
}

const manifestPath = resolve(process.cwd(), process.argv[2] ?? "../../gates.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  gates: GateEntry[];
};

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const { db, client } = createDatabase({ url: databaseUrl, maxConnections: 2 });

const executedBy = process.env["GATE_EXECUTED_BY"] ?? "make gates";
const executedAt = new Date();

for (const gate of manifest.gates) {
  /*
   * The CHECK constraint in 0000_init.sql refuses `passed` without evidence.
   * Failing here with the gate's name attached beats letting the constraint
   * fire with only a table name, because the whole point of the manifest is
   * that a human can see which claim is unsupported.
   */
  if (gate.status === "passed" && !gate.evidenceUrl) {
    throw new Error(
      `gate "${gate.gateId}" is marked passed with no evidenceUrl — ` +
        "a gate closes on evidence, not on assertion",
    );
  }

  await db.insert(verificationRuns).values({
    gateId: gate.gateId,
    clock: gate.clock,
    status: gate.status,
    evidenceUrl: gate.evidenceUrl ?? null,
    executedBy: gate.executedBy ?? executedBy,
    notes: gate.notes ?? null,
    executedAt,
  });
}

const [summary] = await db
  .select({
    total: sql<number>`count(*)::int`,
    passed: sql<number>`count(*) filter (where status = 'passed')::int`,
    executed: sql<number>`count(*) filter (where status = 'executed')::int`,
  })
  .from(verificationRuns);

console.log(
  `recorded ${manifest.gates.length} gate runs; ledger now holds ${summary?.total} rows ` +
    `(${summary?.passed} passed, ${summary?.executed} executed)`,
);

await client.end();
