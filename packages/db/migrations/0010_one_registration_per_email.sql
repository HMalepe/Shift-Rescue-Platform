UPDATE "locum_profiles" SET "sapc_number" = upper(btrim("sapc_number")) WHERE "sapc_number" IS NOT NULL;--> statement-breakpoint
UPDATE "pharmacies" SET "sapc_pharmacy_number" = upper(btrim("sapc_pharmacy_number")) WHERE "sapc_pharmacy_number" IS NOT NULL;--> statement-breakpoint
DROP INDEX "locum_profiles_sapc_key";--> statement-breakpoint
CREATE UNIQUE INDEX "locum_profiles_sapc_key" ON "locum_profiles" USING btree (lower("sapc_number")) WHERE "sapc_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacies_sapc_key" ON "pharmacies" USING btree (lower("sapc_pharmacy_number")) WHERE "sapc_pharmacy_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_members_one_primary" ON "pharmacy_members" USING btree ("user_id") WHERE "is_primary" = true;--> statement-breakpoint
CREATE TABLE "professional_registrations" (
	"number" varchar(32) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "professional_registrations_email_key" ON "professional_registrations" USING btree (lower("email"));--> statement-breakpoint
INSERT INTO "professional_registrations" ("number", "email")
SELECT upper(btrim(lp."sapc_number")), lower(u."email")
FROM "locum_profiles" lp
JOIN "users" u ON u."id" = lp."user_id"
WHERE lp."sapc_number" IS NOT NULL AND btrim(lp."sapc_number") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "professional_registrations" pr
    WHERE pr."number" = upper(btrim(lp."sapc_number"))
       OR lower(pr."email") = lower(u."email")
  )
ON CONFLICT ("number") DO NOTHING;--> statement-breakpoint
INSERT INTO "professional_registrations" ("number", "email")
SELECT upper(btrim(p."sapc_pharmacy_number")), lower(u."email")
FROM "pharmacies" p
JOIN "pharmacy_members" pm ON pm."pharmacy_id" = p."id" AND pm."is_primary" = true
JOIN "users" u ON u."id" = pm."user_id"
WHERE p."sapc_pharmacy_number" IS NOT NULL AND btrim(p."sapc_pharmacy_number") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "professional_registrations" pr
    WHERE pr."number" = upper(btrim(p."sapc_pharmacy_number"))
       OR lower(pr."email") = lower(u."email")
  )
ON CONFLICT ("number") DO NOTHING;
