CREATE TABLE "rate_limit_counters" (
	"subject_id" uuid NOT NULL,
	"action" varchar(60) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY("subject_id","action","window_start")
);
--> statement-breakpoint
ALTER TABLE "rate_limit_counters" ADD CONSTRAINT "rate_limit_counters_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_limit_counters_window_idx" ON "rate_limit_counters" USING btree ("window_start");