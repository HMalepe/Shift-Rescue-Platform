import { initTRPC, TRPCError } from "@trpc/server";
import { consumeQuota, isDomainError, type DomainErrorCode, type QuotaRule } from "@locum/core";
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

    /*
     * Mask the message of anything unexpected.
     *
     * tRPC suppresses the stack outside development but returns the thrown
     * error's MESSAGE verbatim, at every level. Found by booting production
     * with the scanner down and reading what came back:
     *
     *   "clamd connection failed: connect ECONNREFUSED 127.0.0.1:3310"
     *
     * — an internal address and port, handed to any locum who uploads during
     * an outage. It is not specific to the scanner: an S3 failure carries the
     * bucket and key, and a Postgres error can carry a fragment of the query.
     * Everything reaching this branch is a bug or an outage, and neither has a
     * message written with a reader in mind.
     *
     * Domain errors above are exempt because their messages ARE the product's
     * wording, deliberately. The real error is untouched here and still goes
     * to the logger and the §0.1 reporter — this changes what the client is
     * told, not what is recorded.
     */
    if (shape.data.code === "INTERNAL_SERVER_ERROR") {
      /*
       * The stack goes too, and not only in production.
       *
       * tRPC includes it whenever NODE_ENV is not "production", and the stack
       * text CONTAINS the message — so masking one and keeping the other
       * leaks exactly what was just hidden. The first version of this fix did
       * that, and the regression test caught it.
       *
       * Stripping it unconditionally also means the guarantee does not depend
       * on an environment variable being right. A staging box accidentally
       * running as "test" should not be more talkative than production.
       */
      const { stack: _stack, ...data } = shape.data as typeof shape.data & {
        stack?: string;
      };

      return {
        ...shape,
        message: "Something went wrong on our side. Please try again.",
        data,
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
  PHARMACY_NOT_FOUND: "NOT_FOUND",
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
  // §2 billing / Subscribe
  SUBSCRIPTION_NOT_FOUND: "NOT_FOUND",
  SUBSCRIPTION_ALREADY_ACTIVE: "CONFLICT",
  SUBSCRIPTION_CANCELLED: "CONFLICT",
  SUBSCRIPTION_NOT_TOKENIZED: "CONFLICT",
  CHARGE_NOT_FOUND: "NOT_FOUND",
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

/**
 * §12.1 — a per-ACCOUNT quota on a procedure.
 *
 * Layered under the global per-IP limit rather than replacing it. The two
 * catch different attackers: the IP limit stops credential stuffing by someone
 * with no account, and this stops an authenticated user scraping the shift
 * board or spraying booking requests at managers' phones. An authenticated
 * scraper defeats an IP limit by switching to mobile data; they cannot switch
 * account as cheaply, because the account had to pass SAPC verification.
 *
 * Fails CLOSED on a quota error. If the counter cannot be written the limit
 * cannot be enforced, and the endpoints this guards are the ones worth
 * protecting — a browse outage is recoverable, a scraped database is not.
 */
export function quota(rule: QuotaRule) {
  return t.middleware(async ({ ctx, next }) => {
    /*
     * Composed onto an existing procedure rather than returning one of its
     * own. The first version returned `protectedProcedure.use(...)`, which
     * silently DROPPED the role check from every procedure it was applied to —
     * `applyToShift` went from locum-only to any-authenticated-user. The
     * verification check downstream would still have refused a manager, so
     * nothing would have failed visibly; a rate limiter that quietly widens
     * authorization is a bad trade for a limit. Caught by the compiler
     * noticing `locumProcedure` had become unused.
     */
    const user = (ctx as { user: { id: string } | null }).user;
    if (!user) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const result = await consumeQuota(ctx.db, rule, user.id);

    if (!result.allowed) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Too many requests. Try again in ${Math.ceil(
          result.resetInSeconds / 60,
        )} minutes.`,
      });
    }

    return next();
  });
}
