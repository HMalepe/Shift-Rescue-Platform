/**
 * Bootstraps a single user directly in the database.
 *
 * There is no self-service signup endpoint (apps/api/src/routes/auth.ts only
 * has login/refresh/logout) — accounts are provisioned by a pharmacy's own
 * manager workflow, which is not built yet. Until then, this is how the
 * first account(s) get created, including in production, where
 * packages/db/src/seed is deliberately blocked from running at all.
 *
 * Usage (from repo root):
 *   DATABASE_URL=... EMAIL=you@example.com PASSWORD=... FULL_NAME="Your Name" ROLE=manager \
 *     pnpm --filter @locum/api create-user
 *
 * ROLE is "manager", "locum", or "admin". Admin accounts require MFA
 * (packages/core/src/auth/service.ts login()) — this script enrols one
 * automatically and prints the otpauth:// URI so it can be scanned into an
 * authenticator app immediately. There is no later "enrol MFA" endpoint
 * either, so an admin account made without capturing that output is unusable
 * until someone updates its mfa_secret column by hand.
 */
import { randomUUID } from "node:crypto";
import { createDatabase, users } from "@locum/db";
import { hashPassword, generateTotpSecret, totpProvisioningUri } from "@locum/core";

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
if (password.length < 12) {
  console.error("PASSWORD must be at least 12 characters");
  process.exit(1);
}

const { db, client } = createDatabase({ url });

try {
  const passwordHash = await hashPassword(password);

  const mfaFields =
    role === "admin"
      ? { mfaSecret: generateTotpSecret(), mfaEnrolledAt: new Date() }
      : {};

  const [created] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      role,
      email,
      fullName,
      passwordHash,
      ...mfaFields,
    })
    .returning({ id: users.id, email: users.email, role: users.role });

  console.log("created user:", created);

  if (role === "admin" && mfaFields.mfaSecret) {
    console.log("\nMFA secret (save this now, it is not shown again):");
    console.log(mfaFields.mfaSecret);
    console.log("\nScan this into an authenticator app:");
    console.log(totpProvisioningUri(mfaFields.mfaSecret, email));
  }
} catch (error) {
  console.error("create-user failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
