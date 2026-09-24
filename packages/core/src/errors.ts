/**
 * Domain errors.
 *
 * Deliberately framework-free: `packages/core` is consumed by the Fastify API,
 * the BullMQ worker and (via tRPC) both clients, so throwing an HTTP-shaped
 * error here would leak transport concerns into the worker. Each transport maps
 * these to its own representation at its own edge.
 */
export type DomainErrorCode =
  | "SHIFT_NOT_FOUND"
  | "SHIFT_NOT_OPEN"
  | "SHIFT_ALREADY_FILLED"
  | "BOOKING_NOT_FOUND"
  | "BOOKING_NOT_CONFIRMABLE"
  | "LOCUM_NOT_VERIFIED"
  | "NOT_SHIFT_OWNER"
  | "IDEMPOTENCY_KEY_REUSED"
  // §12.1 authentication
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_DISABLED"
  | "TOO_MANY_ATTEMPTS"
  | "MFA_REQUIRED"
  | "MFA_INVALID"
  | "MFA_ENROLMENT_REQUIRED"
  | "INVALID_REFRESH_TOKEN"
  | "REFRESH_TOKEN_REUSED"
  | "SESSION_INVALIDATED"
  | "EMAIL_TAKEN"
  | "SAPC_NUMBER_TAKEN"
  | "ADMIN_EXISTS"
  | "ADMIN_NOT_FOUND"
  // §8 attendance
  | "NOT_BOOKING_OWNER"
  | "BOOKING_NOT_CONFIRMED"
  | "CHECK_IN_TOO_EARLY"
  | "CHECK_IN_TOO_LATE"
  | "ALREADY_CHECKED_IN"
  | "NOT_CHECKED_IN"
  | "ALREADY_CHECKED_OUT"
  // §5 / §12.1 verification
  | "DOCUMENT_REJECTED"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_NOT_REVIEWABLE"
  | "DOCUMENT_ALREADY_REVIEWED"
  | "PHARMACY_NOT_FOUND"
  // §9 cancellation
  | "NOT_BOOKING_PARTICIPANT"
  | "BOOKING_NOT_CANCELLABLE"
  // §6 messaging
  | "THREAD_CLOSED"
  // §10 privacy
  | "SUBJECT_NOT_FOUND"
  | "ALREADY_ERASED"
  // §7 reputation
  | "INVALID_RATING"
  | "SHIFT_NOT_FINISHED"
  | "BOOKING_NOT_RATEABLE"
  | "ALREADY_RATED"
  // §2 billing
  | "SUBSCRIPTION_NOT_FOUND"
  | "SUBSCRIPTION_CANCELLED"
  | "SUBSCRIPTION_ALREADY_ACTIVE"
  | "SUBSCRIPTION_NOT_TOKENIZED"
  | "CHARGE_NOT_FOUND";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * Postgres unique-violation SQLSTATE.
 *
 * The confirm path races two writers against `bookings_one_confirmed_per_shift`.
 * The loser surfaces as this code, and is translated into a clean
 * SHIFT_ALREADY_FILLED rather than being allowed to escape as a 500.
 */
export const PG_UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  if (candidate.code !== PG_UNIQUE_VIOLATION) return false;
  if (constraint === undefined) return true;
  return (
    candidate.constraint_name === constraint || candidate.constraint === constraint
  );
}
