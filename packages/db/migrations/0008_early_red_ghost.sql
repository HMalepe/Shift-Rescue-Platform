CREATE TABLE "reputation_snapshots" (
	"subject_id" uuid PRIMARY KEY NOT NULL,
	"published_rating_count" integer DEFAULT 0 NOT NULL,
	"published_display" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_last_used_counter" integer;--> statement-breakpoint
ALTER TABLE "reputation_snapshots" ADD CONSTRAINT "reputation_snapshots_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;