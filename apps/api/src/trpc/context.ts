import type { FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { sessions, users, type Database, type UserRole } from "@locum/db";
import { verifyAccessToken } from "@locum/core";
import type { Config } from "../config";

export interface AuthenticatedUser {
  readonly id: string;
  readonly role: UserRole;
  /** Whether MFA was satisfied for this session (§12.1). */
  readonly mfaSatisfied: boolean;
  readonly sessionId: string;
}

export interface TrpcContext {
  readonly db: Database;
  readonly config: Config;
  readonly user: AuthenticatedUser | null;
  readonly ipAddress: string;
}

export interface ContextDeps {
  readonly db: Database;
  readonly config: Config;
}

/**
 * Resolves the caller from a Bearer access token.
 *
 * The token's signature and expiry are checked locally — that is the whole
 * point of a short-lived signed token — but the session is ALSO looked up.
 * A purely local check would let a revoked session keep working until its
 * access token expired, which for a suspended admin means up to 15 minutes of
 * continued authority to mark employment "verified" (§12.1).
 *
 * 15 minutes is the deliberate trade: short enough that the revocation window
 * is small, long enough that the lookup is not on the hot path of every
 * request from a chatty client. Sessions are indexed by primary key, so the
 * check is a single point read.
 */
export async function createContext(
  deps: ContextDeps,
  request: FastifyRequest,
): Promise<TrpcContext> {
  const base = {
    db: deps.db,
    config: deps.config,
    ipAddress: request.ip,
  };

  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return { ...base, user: null };
  }

  const verified = verifyAccessToken(header.slice(7), deps.config.AUTH_SECRET);
  if (!verified.valid) {
    return { ...base, user: null };
  }

  const { claims } = verified;

  const [row] = await deps.db
    .select({
      sessionRevokedAt: sessions.revokedAt,
      sessionIssuedAt: sessions.issuedAt,
      userDisabledAt: users.disabledAt,
      sessionsValidFrom: users.sessionsValidFrom,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, claims.sid), isNull(sessions.revokedAt)))
    .limit(1);

  // Any of: session revoked, user disabled, or the password-change watermark
  // has moved past this session. All three must deny immediately rather than
  // waiting for token expiry.
  if (
    !row ||
    row.sessionRevokedAt !== null ||
    row.userDisabledAt !== null ||
    row.sessionIssuedAt < row.sessionsValidFrom
  ) {
    return { ...base, user: null };
  }

  return {
    ...base,
    user: {
      id: claims.sub,
      // Role comes from the database, not the token. A role changed since the
      // token was issued must take effect now — a demoted admin should not
      // keep admin authority for the life of their access token.
      role: row.role,
      mfaSatisfied: claims.mfa,
      sessionId: claims.sid,
    },
  };
}
