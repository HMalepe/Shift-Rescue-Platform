CREATE TYPE "public"."nearby_nudge_frequency" AS ENUM('off', '1h', '2h', '3h', '4h', '6h', 'daily');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "nearby_nudge_frequency" "nearby_nudge_frequency" DEFAULT 'daily' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "nearby_nudge_last_sent_at" timestamp with time zone;