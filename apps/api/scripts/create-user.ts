/**
 * Bootstraps a single user directly in the database.
 *
 * Prefer creating the first admin in the browser: set ADMIN_EMAIL and
 * ADMIN_PASSWORD on Vercel and open /setup. This script remains for extra
 * accounts.
 *
 * There used to be no self-service locum/manager signup; that path exists now
 * at /auth/register. Admin still cannot self-serve except via /setup once.
 *
 * Usage (from repo root):
 *   DATABASE_URL=... EMAIL=you@example.com PASSWORD=... FULL_NAME="Your Name" ROLE=manager \
 *     pnpm --filter @locum/api create-user
 *
 * ROLE is "manager", "locum", or "admin". Admin accounts sign in with email
 * and password, the same as every other role.
 */
import { randomUUID } from "node:crypto";
import { createDatabase, users } from "@locum/db";
import { hashPassword } from "@locum/core";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const email = process.env["EMAIL"];
const password = process.env["PASSWORD"];
const fullName = process.env["FULL_NAME"];
const role = process.env["ROLE"] ?? "manager";

if (!email || !password || !fullName) {
  console.error("EMAIL, PASSWORD and FULL_NAME are all required");
  process.exit(1);
}
if (role !== "manager" && role !== "locum" && role !== "admin") {
  console.error(`ROLE must be manager, locum or admin — got: ${role}`);
  process.exit(1);
}

const { db, client } = createDatabase({ url });

try {
  const passwordHash = await hashPassword(password);

  const [created] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      role,
      email,
      fullName,
      passwordHash,
    })
    .returning({ id: users.id, email: users.email, role: users.role });

  console.log("created user:", created);
} catch (error) {
  console.error("create-user failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
