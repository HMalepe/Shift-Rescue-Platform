import { initTRPC, TRPCError } from "@trpc/server";
import { isDomainError, type DomainErrorCode } from "@locum/core";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  errorFormatter({ shape, error }) {
    // Surface the domain error code so clients can branch on it without
    // parsing prose. The message is already written to be user-safe.
    const cause = error.cause;
    if (isDomainError(cause)) {
      return {
        ...shape,
        data: { ...shape.data, domainCode: cause.code },
      };
    }
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Translates domain errors into tRPC errors.
 *
 * Applied as middleware rather than try/catch in every procedure, so a new
 * procedure cannot forget it and leak a raw stack trace to a client.
 */
const HTTP_BY_DOMAIN_CODE: Partial<
  Record<DomainErrorCode, TRPCError["code"]>
> = {
  SHIFT_NOT_FOUND: "NOT_FOUND",
  BOOKING_NOT_FOUND: "NOT_FOUND",
  NOT_SHIFT_OWNER: "FORBIDDEN",
  LOCUM_NOT_VERIFIED: "FORBIDDEN",
  SHIFT_ALREADY_FILLED: "CONFLICT",
  SHIFT_NOT_OPEN: "CONFLICT",
  BOOKING_NOT_CONFIRMABLE: "CONFLICT",
  IDEMPOTENCY_KEY_REUSED: "CONFLICT",
  TOO_MANY_ATTEMPTS: "TOO_MANY_REQUESTS",
  // §8 attendance
  NOT_BOOKING_OWNER: "FORBIDDEN",
  BOOKING_NOT_CONFIRMED: "CONFLICT",
  CHECK_IN_TOO_EARLY: "CONFLICT",
  CHECK_IN_TOO_LATE: "CONFLICT",
  ALREADY_CHECKED_IN: "CONFLICT",
  NOT_CHECKED_IN: "CONFLICT",
  ALREADY_CHECKED_OUT: "CONFLICT",
  // §5 / §12.1 verification
  DOCUMENT_REJECTED: "BAD_REQUEST",
  DOCUMENT_NOT_FOUND: "NOT_FOUND",
  DOCUMENT_NOT_REVIEWABLE: "CONFLICT",
  DOCUMENT_ALREADY_REVIEWED: "CONFLICT",
  // §9 cancellation
  NOT_BOOKING_PARTICIPANT: "FORBIDDEN",
  BOOKING_NOT_CANCELLABLE: "CONFLICT",
  // §10 privacy
  SUBJECT_NOT_FOUND: "NOT_FOUND",
  ALREADY_ERASED: "CONFLICT",
  // §7 reputation
  INVALID_RATING: "BAD_REQUEST",
  SHIFT_NOT_FINISHED: "CONFLICT",
  BOOKING_NOT_RATEABLE: "CONFLICT",
  ALREADY_RATED: "CONFLICT",
  // §6 messaging. A closed thread is a state conflict, not a permission
  // problem: the caller IS a participant, the window has simply passed.
  THREAD_CLOSED: "CONFLICT",
};

const withDomainErrors = t.middleware(async ({ next }) => {
  /*
   * tRPC middlewares do NOT see downstream exceptions as thrown errors —
   * `next()` resolves to a MiddlewareResult that is either `{ ok: true }` or
   * `{ ok: false, error }`, with the original throw preserved on
   * `error.cause`.
   *
   * A try/catch around `next()` therefore never fires, which is exactly the
   * bug this replaced: every DomainError fell through to the default handler
   * and surfaced as a 500. An outsider trying to confirm another pharmacy's
   * booking got "internal server error" instead of a clean 403, which reads
   * as a broken API rather than a refused one — and would have buried a real
   * authorisation signal in the noise of genuine 500s.
   */
  const result = await next();
  if (result.ok) return result;

  const cause = result.error.cause;
  if (isDomainError(cause)) {
    throw new TRPCError({
      code: HTTP_BY_DOMAIN_CODE[cause.code] ?? "BAD_REQUEST",
      message: cause.message,
      cause,
    });
  }
  return result;
});

const requireAuth = withDomainErrors.unstable_pipe(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(requireAuth);

/**
 * Role gates.
 *
 * These are a first line, not the only line: the domain services in
 * packages/core re-check ownership themselves, because the worker and any
 * future transport call them without passing through here. §12.1 treats the
 * ability to act on someone else's shift as an authorisation boundary, and a
 * boundary enforced in exactly one place is one refactor away from being
 * enforced nowhere.
 */
export const managerProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Managers only" });
  }
  return next({ ctx });
});

export const locumProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "locum") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Locums only" });
  }
  return next({ ctx });
});

/**
 * Admin, with MFA actually required at request time (§12.1).
 *
 * Checking the role alone would be insufficient: it would trust that login
 * enforced MFA. This asserts the session itself carries the MFA claim, so an
 * admin session created by any path that skipped MFA is refused here too.
 */
export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admins only" });
  }
  if (!ctx.user.mfaSatisfied) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Multi-factor authentication is required for admin actions",
    });
  }
  return next({ ctx });
});
