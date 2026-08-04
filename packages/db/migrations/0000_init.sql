-- Added by scripts/postprocess-migration.ts (see that file for why).
-- PostGIS backs every proximity query; pgcrypto backs gen_random_uuid().
CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('requested', 'confirmed', 'cancelled_by_locum', 'cancelled_by_manager', 'completed', 'disputed', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."charge_status" AS ENUM('pending', 'succeeded', 'failed', 'retrying', 'abandoned', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('sapc_certificate', 'identity_document', 'payslip', 'employment_letter', 'pharmacy_licence');--> statement-breakpoint
CREATE TYPE "public"."gate_clock" AS ENUM('A', 'B', 'C');--> statement-breakpoint
CREATE TYPE "public"."gate_status" AS ENUM('not_started', 'generated', 'executed', 'passed', 'failed', 'waived');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('payfast', 'ozow');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'clean', 'infected', 'scan_failed');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('draft', 'open', 'filled', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."shift_visibility" AS ENUM('favourites_only', 'radius');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'restricted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('manager', 'locum', 'admin');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('incomplete', 'complete_unverified', 'in_review', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_category" AS ENUM('utility', 'marketing', 'authentication');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'undelivered');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" varchar(80) NOT NULL,
	"subject_type" varchar(60) NOT NULL,
	"subject_id" uuid,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pharmacy_id" uuid,
	"type" "document_type" NOT NULL,
	"storage_key" text NOT NULL,
	"detected_mime_type" varchar(120) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"scan" "scan_status" DEFAULT 'pending' NOT NULL,
	"scanned_at" timestamp with time zone,
	"scan_detail" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locum_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sapc_number" varchar(32),
	"verification" "verification_status" DEFAULT 'incomplete' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"base_location" geography(Point, 4326),
	"max_travel_km" integer DEFAULT 25 NOT NULL,
	"reliability_score" smallint,
	"completed_shifts" integer DEFAULT 0 NOT NULL,
	"late_cancellations" integer DEFAULT 0 NOT NULL,
	"no_shows" integer DEFAULT 0 NOT NULL,
	"available_from" timestamp with time zone,
	"availability_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pharmacies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"trading_name" varchar(200),
	"sapc_pharmacy_number" varchar(32),
	"address_line" text NOT NULL,
	"suburb" varchar(120),
	"city" varchar(120) NOT NULL,
	"province" varchar(60) DEFAULT 'Gauteng' NOT NULL,
	"postal_code" varchar(10),
	"location" geography(Point, 4326) NOT NULL,
	"verification" "verification_status" DEFAULT 'incomplete' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pharmacy_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pharmacy_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "user_role" NOT NULL,
	"email" varchar(320) NOT NULL,
	"phone" varchar(20),
	"full_name" varchar(200) NOT NULL,
	"password_hash" text,
	"mfa_secret" text,
	"mfa_enrolled_at" timestamp with time zone,
	"sessions_valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"popia_consent_at" timestamp with time zone,
	"whatsapp_opt_in_at" timestamp with time zone,
	"whatsapp_opt_out_at" timestamp with time zone,
	"quiet_hours_start" time DEFAULT '21:00' NOT NULL,
	"quiet_hours_end" time DEFAULT '07:00' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"locum_id" uuid NOT NULL,
	"status" "booking_status" DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancellation_reason" text,
	"was_late_cancellation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"checked_in_at" timestamp with time zone,
	"check_in_location" geography(Point, 4326),
	"check_in_accuracy_m" smallint,
	"checked_out_at" timestamp with time zone,
	"check_out_location" geography(Point, 4326),
	"check_out_accuracy_m" smallint,
	"mock_location_detected" boolean,
	"device_signals" jsonb,
	"check_in_distance_m" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favourite_locums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pharmacy_id" uuid NOT NULL,
	"locum_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid,
	"shift_id" uuid,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"flagged_disintermediation" boolean DEFAULT false NOT NULL,
	"flag_reason" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"rater_id" uuid NOT NULL,
	"ratee_id" uuid NOT NULL,
	"score" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pharmacy_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"hourly_rate_cents" integer NOT NULL,
	"visibility" "shift_visibility" DEFAULT 'favourites_only' NOT NULL,
	"radius_km" integer,
	"status" "shift_status" DEFAULT 'draft' NOT NULL,
	"location" geography(Point, 4326) NOT NULL,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cancellation_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"amount_cents" integer DEFAULT 1000 NOT NULL,
	"notice_hours" smallint NOT NULL,
	"applied_to_charge_id" uuid,
	"waived_at" timestamp with time zone,
	"waived_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" charge_status DEFAULT 'pending' NOT NULL,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"provider_ref" varchar(120),
	"failure_code" varchar(60),
	"failure_detail" text,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pharmacy_id" uuid NOT NULL,
	"status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" varchar(120),
	"monthly_cents" integer NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"restricted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(60) NOT NULL,
	"key" varchar(255) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"response_status" integer,
	"response_body" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gate_id" varchar(64) NOT NULL,
	"clock" "gate_clock" NOT NULL,
	"status" "gate_status" DEFAULT 'not_started' NOT NULL,
	"evidence_url" text,
	"executed_by" varchar(120),
	"notes" text,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_message_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twilio_sid" varchar(64) NOT NULL,
	"user_id" uuid,
	"template_type" varchar(50),
	"category" "whatsapp_category",
	"direction" "whatsapp_direction" NOT NULL,
	"status" "whatsapp_status" DEFAULT 'queued' NOT NULL,
	"was_freeform" varchar(5),
	"price_cents" integer,
	"error_code" varchar(20),
	"status_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_pharmacy_id_pharmacies_id_fk" FOREIGN KEY ("pharmacy_id") REFERENCES "public"."pharmacies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locum_profiles" ADD CONSTRAINT "locum_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locum_profiles" ADD CONSTRAINT "locum_profiles_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_members" ADD CONSTRAINT "pharmacy_members_pharmacy_id_pharmacies_id_fk" FOREIGN KEY ("pharmacy_id") REFERENCES "public"."pharmacies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_members" ADD CONSTRAINT "pharmacy_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_locum_id_locum_profiles_user_id_fk" FOREIGN KEY ("locum_id") REFERENCES "public"."locum_profiles"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourite_locums" ADD CONSTRAINT "favourite_locums_pharmacy_id_pharmacies_id_fk" FOREIGN KEY ("pharmacy_id") REFERENCES "public"."pharmacies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourite_locums" ADD CONSTRAINT "favourite_locums_locum_id_locum_profiles_user_id_fk" FOREIGN KEY ("locum_id") REFERENCES "public"."locum_profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_rater_id_users_id_fk" FOREIGN KEY ("rater_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_ratee_id_users_id_fk" FOREIGN KEY ("ratee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_pharmacy_id_pharmacies_id_fk" FOREIGN KEY ("pharmacy_id") REFERENCES "public"."pharmacies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_fees" ADD CONSTRAINT "cancellation_fees_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_fees" ADD CONSTRAINT "cancellation_fees_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_fees" ADD CONSTRAINT "cancellation_fees_applied_to_charge_id_subscription_charges_id_fk" FOREIGN KEY ("applied_to_charge_id") REFERENCES "public"."subscription_charges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pharmacy_id_pharmacies_id_fk" FOREIGN KEY ("pharmacy_id") REFERENCES "public"."pharmacies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_message_log" ADD CONSTRAINT "whatsapp_message_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "documents_user_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_scan_idx" ON "documents" USING btree ("scan");--> statement-breakpoint
CREATE INDEX "documents_sha256_idx" ON "documents" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "locum_profiles_base_location_gist" ON "locum_profiles" USING gist ("base_location");--> statement-breakpoint
CREATE INDEX "locum_profiles_verification_idx" ON "locum_profiles" USING btree ("verification");--> statement-breakpoint
CREATE UNIQUE INDEX "locum_profiles_sapc_key" ON "locum_profiles" USING btree ("sapc_number") WHERE "locum_profiles"."sapc_number" is not null;--> statement-breakpoint
CREATE INDEX "pharmacies_location_gist" ON "pharmacies" USING gist ("location");--> statement-breakpoint
CREATE INDEX "pharmacies_city_idx" ON "pharmacies" USING btree ("city");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_members_unique" ON "pharmacy_members" USING btree ("pharmacy_id","user_id");--> statement-breakpoint
CREATE INDEX "pharmacy_members_user_idx" ON "pharmacy_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_key" ON "users" USING btree ("phone") WHERE "users"."phone" is not null;--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_one_confirmed_per_shift" ON "bookings" USING btree ("shift_id") WHERE "bookings"."status" = 'confirmed';--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_one_live_request_per_locum" ON "bookings" USING btree ("shift_id","locum_id") WHERE "bookings"."status" in ('requested', 'confirmed');--> statement-breakpoint
CREATE INDEX "bookings_locum_idx" ON "bookings" USING btree ("locum_id");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "check_ins_booking_key" ON "check_ins" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "check_ins_mock_idx" ON "check_ins" USING btree ("mock_location_detected") WHERE "check_ins"."mock_location_detected" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "favourite_locums_unique" ON "favourite_locums" USING btree ("pharmacy_id","locum_id");--> statement-breakpoint
CREATE INDEX "favourite_locums_locum_idx" ON "favourite_locums" USING btree ("locum_id");--> statement-breakpoint
CREATE INDEX "messages_booking_idx" ON "messages" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "messages_flagged_idx" ON "messages" USING btree ("created_at") WHERE "messages"."flagged_disintermediation" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "ratings_booking_rater_key" ON "ratings" USING btree ("booking_id","rater_id");--> statement-breakpoint
CREATE INDEX "ratings_ratee_idx" ON "ratings" USING btree ("ratee_id");--> statement-breakpoint
CREATE INDEX "shifts_location_gist" ON "shifts" USING gist ("location");--> statement-breakpoint
CREATE INDEX "shifts_pharmacy_idx" ON "shifts" USING btree ("pharmacy_id");--> statement-breakpoint
CREATE INDEX "shifts_open_starts_idx" ON "shifts" USING btree ("starts_at") WHERE "shifts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "shifts_status_idx" ON "shifts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "cancellation_fees_booking_key" ON "cancellation_fees" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "cancellation_fees_unapplied_idx" ON "cancellation_fees" USING btree ("subscription_id") WHERE "cancellation_fees"."applied_to_charge_id" is null;--> statement-breakpoint
CREATE INDEX "subscription_charges_subscription_idx" ON "subscription_charges" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "subscription_charges_retry_idx" ON "subscription_charges" USING btree ("next_retry_at") WHERE "subscription_charges"."status" = 'retrying';--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_charges_provider_ref_key" ON "subscription_charges" USING btree ("provider_ref") WHERE "subscription_charges"."provider_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_pharmacy_active_key" ON "subscriptions" USING btree ("pharmacy_id") WHERE "subscriptions"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "subscriptions_period_end_idx" ON "subscriptions" USING btree ("current_period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_key" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "verification_runs_gate_idx" ON "verification_runs" USING btree ("gate_id");--> statement-breakpoint
CREATE INDEX "verification_runs_status_idx" ON "verification_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_message_log_twilio_sid_key" ON "whatsapp_message_log" USING btree ("twilio_sid");--> statement-breakpoint
CREATE INDEX "whatsapp_message_log_user_idx" ON "whatsapp_message_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "whatsapp_message_log_created_category_idx" ON "whatsapp_message_log" USING btree ("created_at","category");--> statement-breakpoint
-- §12.5: "A gate cannot move to `passed` without a non-null evidence_url."
-- Enforced by the database so it holds regardless of which code path writes.
ALTER TABLE "verification_runs"
  ADD CONSTRAINT "verification_runs_passed_requires_evidence"
  CHECK ("status" <> 'passed' OR "evidence_url" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_hourly_rate_non_negative"
  CHECK ("hourly_rate_cents" >= 0);--> statement-breakpoint
ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_ends_after_starts"
  CHECK ("ends_at" > "starts_at");--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_monthly_non_negative"
  CHECK ("monthly_cents" >= 0);--> statement-breakpoint
-- §7 reputation is a 1-5 star score.
ALTER TABLE "ratings"
  ADD CONSTRAINT "ratings_score_range"
  CHECK ("score" BETWEEN 1 AND 5);--> statement-breakpoint
-- §10.1 — a radius shift must actually carry a radius.
ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_radius_required_when_radius_visibility"
  CHECK ("visibility" <> 'radius' OR "radius_km" IS NOT NULL);
