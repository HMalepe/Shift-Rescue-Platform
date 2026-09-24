import { pgEnum } from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["manager", "locum", "admin"]);

/**
 * §5 draws a hard line between "complete" (the locum filled in the form) and
 * "verified" (a human admin checked the SAPC certificate against the registry).
 * Only `verified` may be surfaced to a manager as trustworthy, so these are
 * distinct states rather than a boolean.
 */
export const verificationStatus = pgEnum("verification_status", [
  "incomplete",
  "complete_unverified",
  "in_review",
  "verified",
  "rejected",
]);

export const documentType = pgEnum("document_type", [
  "sapc_certificate",
  "identity_document",
  "payslip",
  "employment_letter",
  "pharmacy_licence",
]);

/**
 * §12.1 requires uploads be scanned before storage is trusted. A document is
 * never servable until it reaches `clean`.
 */
export const scanStatus = pgEnum("scan_status", [
  "pending",
  "clean",
  "infected",
  "scan_failed",
]);

/**
 * §10.1: the default reach of a new shift is favourited locums only. Widening
 * to a radius is an explicit separate action, so visibility is a stored
 * property of the shift rather than an implicit consequence of matching.
 */
export const shiftVisibility = pgEnum("shift_visibility", [
  "favourites_only",
  "radius",
]);

export const shiftStatus = pgEnum("shift_status", [
  "draft",
  "open",
  "filled",
  "cancelled",
  "completed",
]);

/**
 * §14 requires fixtures across every booking state, including the terminal
 * dispute state that reputation (§7) and cancellation fees (§9) both read.
 */
export const bookingStatus = pgEnum("booking_status", [
  "requested",
  "confirmed",
  "cancelled_by_locum",
  "cancelled_by_manager",
  "completed",
  "disputed",
  "no_show",
]);

export const subscriptionStatus = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "restricted",
  "cancelled",
]);

/**
 * §2 dunning state machine. `restricted` is distinct from `cancelled`: a
 * restricted pharmacy keeps its data and can still be collected from, it just
 * loses the ability to post new shifts.
 */
export const chargeStatus = pgEnum("charge_status", [
  "pending",
  "succeeded",
  "failed",
  "retrying",
  "abandoned",
  "disputed",
]);

export const paymentProvider = pgEnum("payment_provider", ["payfast", "ozow"]);

/** §11.2 — misclassifying a template gets it rejected by Meta. */
export const whatsappCategory = pgEnum("whatsapp_category", [
  "utility",
  "marketing",
  "authentication",
]);

export const whatsappDirection = pgEnum("whatsapp_direction", [
  "outbound",
  "inbound",
]);

export const whatsappStatus = pgEnum("whatsapp_status", [
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "undelivered",
]);

/**
 * §11 nearby-activity nudges ("N locums near you" / "N pharmacies hiring near
 * you"). Real-time reciprocal matching (a locum toggling available near a
 * pharmacy that's looking) bypasses this entirely — it fires immediately.
 * This is only the fallback cadence for someone idle: how long between
 * digests before the count is worth re-sending. `daily` is the ceiling
 * deliberately — anything less frequent is not really a nudge.
 */
export const nearbyNudgeFrequency = pgEnum("nearby_nudge_frequency", [
  "off",
  "1h",
  "2h",
  "3h",
  "4h",
  "6h",
  "daily",
]);

/** §12.5 — gate status recorded as data, not in a drifting document. */
export const gateClock = pgEnum("gate_clock", ["A", "B", "C"]);

export const gateStatus = pgEnum("gate_status", [
  "not_started",
  "generated",
  "executed",
  "passed",
  "failed",
  "waived",
]);

/*
 * TypeScript unions derived from the pgEnums above.
 *
 * Derived rather than hand-written: a separate `type UserRole = "manager" | ...`
 * would be a second copy of the same list, and the two would eventually
 * disagree. `.enumValues` keeps them structurally identical, so adding a
 * variant to the pgEnum widens the type automatically.
 */
export type UserRole = (typeof userRole.enumValues)[number];
export type VerificationStatus = (typeof verificationStatus.enumValues)[number];
export type DocumentType = (typeof documentType.enumValues)[number];
export type ScanStatus = (typeof scanStatus.enumValues)[number];
export type ShiftVisibility = (typeof shiftVisibility.enumValues)[number];
export type ShiftStatus = (typeof shiftStatus.enumValues)[number];
export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type SubscriptionStatus = (typeof subscriptionStatus.enumValues)[number];
export type ChargeStatus = (typeof chargeStatus.enumValues)[number];
export type PaymentProvider = (typeof paymentProvider.enumValues)[number];
export type WhatsappCategory = (typeof whatsappCategory.enumValues)[number];
export type WhatsappDirection = (typeof whatsappDirection.enumValues)[number];
export type WhatsappStatus = (typeof whatsappStatus.enumValues)[number];
export type GateClock = (typeof gateClock.enumValues)[number];
export type GateStatus = (typeof gateStatus.enumValues)[number];
export type NearbyNudgeFrequency = (typeof nearbyNudgeFrequency.enumValues)[number];
