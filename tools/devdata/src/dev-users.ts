import { eq, sql } from "drizzle-orm";
import { hashPassword } from "@locum/core";
import { createDatabase } from "@locum/db";
import { locumProfiles, pharmacyMembers, users } from "@locum/db/schema";

/**
 * Gives the seeded fixtures a way to sign in, and creates an admin.
 *
 * The §14 seed generator deliberately writes no password hashes — it exists to
 * produce realistic *data* for load tests and query plans, and 5,200 accounts
 * each carrying a real Argon2id hash would take minutes to generate and would
 * be 5,200 live credentials sitting in a fixture. So the seeded world is
 * complete and entirely un-loggable-into, which is correct for its purpose and
 * useless for opening the app and looking at it.
 *
 * This script closes that gap for exactly three accounts.
 *
 * It refuses to run in production. Not because anyone plans to run it there,
 * but because a script whose whole job is "set a known password on an existing
 * account" is a privilege-escalation tool if it ever reaches an environment
 * with real users in it, and the guard costs three lines.
 *
 * It lives in tools/ rather than packages/db because it needs `hashPassword`
 * from @locum/core, and core already depends on db — putting it there would
 * make that cycle real.
 */

if (process.env["NODE_ENV"] === "production") {
  throw new Error(
    "dev-users refuses to run in production — it sets known passwords on real accounts",
  );
}

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const PASSWORD = process.env["DEV_PASSWORD"] ?? "locum-dev-password-1";

const { db, client } = createDatabase({ url: databaseUrl, maxConnections: 2 });
const passwordHash = await hashPassword(PASSWORD);

/*
 * A manager who actually belongs to a pharmacy, and a locum who is actually
 * verified. Picking arbitrary rows would produce accounts that log in and then
 * show an empty screen — a manager with no pharmacy cannot post, and an
 * unverified locum cannot apply (§5).
 */
const [manager] = await db
  .select({ id: users.id, email: users.email })
  .from(users)
  .innerJoin(pharmacyMembers, eq(pharmacyMembers.userId, users.id))
  .where(eq(users.role, "manager"))
  .limit(1);

const [locum] = await db
  .select({ id: users.id, email: users.email })
  .from(users)
  .innerJoin(locumProfiles, eq(locumProfiles.userId, users.id))
  .where(sql`${users.role} = 'locum' and ${locumProfiles.verification} = 'verified'`)
  .limit(1);

if (!manager || !locum) {
  throw new Error("no seeded manager/verified locum found — run `make seed` first");
}

for (const account of [manager, locum]) {
  await db
    .update(users)
    .set({ passwordHash, sessionsValidFrom: new Date(0) })
    .where(eq(users.id, account.id));
}

/*
 * The admin is created rather than borrowed: §14's fixtures contain none.
 * Sign-in is email and password, the same as the other fixture accounts.
 */
const adminEmail = process.env["DEV_ADMIN_EMAIL"] ?? "admin@locumplanner.test";

const [existingAdmin] = await db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, adminEmail))
  .limit(1);

if (existingAdmin) {
  await db
    .update(users)
    .set({ passwordHash, mfaSecret: null, mfaEnrolledAt: null, sessionsValidFrom: new Date(0) })
    .where(eq(users.id, existingAdmin.id));
} else {
  await db.insert(users).values({
    role: "admin",
    email: adminEmail,
    fullName: "Dev Admin",
    passwordHash,
  });
}

console.log(
  [
    "",
    "  Development sign-ins (this environment only)",
    `    password        ${PASSWORD}`,
    "",
    `    manager         ${manager.email}`,
    `    locum           ${locum.email}`,
    `    admin           ${adminEmail}`,
    "",
  ].join("\n"),
);

await client.end();
