CREATE TABLE "shift_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"locum_id" uuid NOT NULL,
	"ring" integer NOT NULL,
	"distance_m" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_locum_id_locum_profiles_user_id_fk" FOREIGN KEY ("locum_id") REFERENCES "public"."locum_profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_offers_unique" ON "shift_offers" USING btree ("shift_id","locum_id");--> statement-breakpoint
CREATE INDEX "shift_offers_shift_idx" ON "shift_offers" USING btree ("shift_id");