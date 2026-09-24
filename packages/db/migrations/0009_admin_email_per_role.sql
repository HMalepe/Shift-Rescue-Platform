DROP INDEX "users_email_lower_key";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_role_key" ON "users" USING btree (lower("email"), "role");
