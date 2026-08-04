import { createDatabase } from "../client";
import { seed } from "./index";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

/**
 * Guard against seeding a real database. The seed TRUNCATEs every table, so
 * this check is the difference between a fixture refresh and an outage.
 */
if (process.env["ENVIRONMENT"] === "production") {
  console.error("refusing to seed: ENVIRONMENT=production");
  process.exit(1);
}

const numberFromEnv = (key: string): number | undefined => {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`${key} must be a number, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
};

const { db, client } = createDatabase({ url });

try {
  const summary = await seed(db, {
    ...(numberFromEnv("SEED_LOCUMS") !== undefined && { locums: numberFromEnv("SEED_LOCUMS")! }),
    ...(numberFromEnv("SEED_PHARMACIES") !== undefined && { pharmacies: numberFromEnv("SEED_PHARMACIES")! }),
    ...(numberFromEnv("SEED_FAVOURITES") !== undefined && { favouritesPerPharmacy: numberFromEnv("SEED_FAVOURITES")! }),
    ...(numberFromEnv("SEED_SEED") !== undefined && { seed: numberFromEnv("SEED_SEED")! }),
  });
  console.table(summary);
} catch (error) {
  console.error("seed failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
