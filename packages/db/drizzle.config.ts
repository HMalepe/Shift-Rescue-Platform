import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env["DATABASE_URL"] ??
      "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev",
  },
  // Keep generated SQL reviewable: this schema carries invariants (partial
  // unique indexes, CHECK constraints) that a human must read before they ship.
  verbose: true,
  strict: true,
});
