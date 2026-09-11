import type { FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { sessions, users, type Database, type UserRole } from "@locum/db";
import {
  verifyAccessToken,
  type DocumentScanner,
  type DocumentStorage,
  type WhatsAppSender,
} from "@locum/core";
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
  /** Injected so the verification workflow is testable without S3/ClamAV. */
  readonly documentStorage: DocumentStorage;
  readonly documentScanner: DocumentScanner;
  /**
   * §12.3 — the API sends WhatsApp now.
   *
   * It did not before this: every message came from the worker. The Phase 3
   * "Looking for a Locum" toggle fires ring 0 inline, because the spec's whole
   * framing is "the instant a manager toggles" — so the sender has to be here,
   * and `assertProductionReady` has to refuse the fake here too.
   */
  readonly whatsappSender: WhatsAppSender;
}

export interface ContextDeps {
  readonly db: Database;
  readonly config: Config;
  readonly documentStorage: DocumentStorage;
  readonly documentScanner: DocumentScanner;
  readonly whatsappSender: WhatsAppSender;
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
/**
 * Resolves the caller from a Bearer access token, independent of tRPC.
 *
 * Factored out of `createContext` so the one REST route that streams binary
 * data (`GET /documents/:id` — tRPC's JSON transport cannot carry document
 * bytes) authenticates with exactly the same session-revocation, user-disabled
 * and password-watermark checks as every tRPC procedure, rather than a
 * hand-rolled copy that quietly drifts from them.
 */
export async function resolveAuthenticatedUser(
  deps: Pick<ContextDeps, "db" | "config">,
  request: FastifyRequest,
): Promise<AuthenticatedUser | null> {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }

  const verified = verifyAccessToken(header.slice(7), deps.config.AUTH_SECRET);
  if (!verified.valid) {
    return null;
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
    return null;
  }

  return {
    id: claims.sub,
    // Role comes from the database, not the token. A role changed since the
    // token was issued must take effect now — a demoted admin should not
    // keep admin authority for the life of their access token.
    role: row.role,
    mfaSatisfied: claims.mfa,
    sessionId: claims.sid,
  };
}

export async function createContext(
  deps: ContextDeps,
  request: FastifyRequest,
): Promise<TrpcContext> {
  const base = {
    db: deps.db,
    config: deps.config,
    ipAddress: request.ip,
    documentStorage: deps.documentStorage,
    documentScanner: deps.documentScanner,
    whatsappSender: deps.whatsappSender,
  };

  const user = await resolveAuthenticatedUser(deps, request);
  return { ...base, user };
}
