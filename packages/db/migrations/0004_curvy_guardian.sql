ALTER TABLE "whatsapp_message_log" ADD COLUMN "variables" jsonb;--> statement-breakpoint
ALTER TABLE "whatsapp_message_log" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_message_log" ADD COLUMN "claimed_by" varchar(64);