import { randomUUID } from "node:crypto";
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { authAttempts, sessions, users, type Database, type UserRole } from "@locum/db";
import { DomainError } from "../errors";
import { getDummyHash, hashPassword, verifyPassword } from "./password";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  type AccessTokenClaims,
} from "./tokens";
import { matchedTotpCounter } from "./totp";

export interface AuthConfig {
  readonly secret: string;
  /** Access-token lifetime. Short by design: revocation is only checked on refresh. */
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  /** §12.1 — failed attempts before an identifier is locked out. */
  readonly maxFailedAttempts: number;
  readonly lockoutWindowSeconds: number;
}

export const DEFAULT_AUTH_CONFIG: Omit<AuthConfig, "secret"> = {
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  maxFailedAttempts: 10,
  lockoutWindowSeconds: 15 * 60,
};

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  /** Required for admin accounts once enrolled (§12.1). */
  readonly totpCode?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly userId: string;
  readonly role: UserRole;
}

/**
 * §12.1 — authentication.
 *
 * Three requirements from the spec drive the shape of this file:
 *   - token expiry/refresh strategy
 *   - session invalidation on password change
 *   - rate limiting on login/signup to prevent credential stuffing
 *
 * Plus one that is specific to this product: admin accounts can mark
 * employment "verified", which is the single most valuable capability on the
 * platform. They are therefore treated as a distinct trust tier and cannot
 * authenticate with a password alone.
 */
export async function login(
  db: Database,
  config: AuthConfig,
  input: LoginInput,
): Promise<TokenPair> {
  const email = input.email.trim().toLowerCase();

  await assertNotLockedOut(db, config, email);

  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      passwordHash: users.passwordHash,
      mfaSecret: users.mfaSecret,
      mfaEnrolledAt: users.mfaEnrolledAt,
      mfaLastUsedCounter: users.mfaLastUsedCounter,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  /*
   * Timing equalisation.
   *
   * When the account does not exist there is no hash to verify, so a naive
   * implementation returns immediately while a real account spends ~50ms in
   * Argon2. That gap is measurable remotely and turns login into a user
   * enumeration oracle — here that means confirming whether a named pharmacist
   * is on the platform, which is a POPIA exposure (§10) as much as a security
   * one. Verifying against a dummy hash spends the same work either way.
   */
  const storedHash = user?.passwordHash ?? (await getDummyHash());
  const passwordOk = await verifyPassword(storedHash, input.password);

  if (!user || !user.passwordHash || !passwordOk) {
    await recordAttempt(db, email, input.ipAddress, false, user ? "bad_password" : "no_such_user");
    throw new DomainError("INVALID_CREDENTIALS", "Invalid email or password");
  }

  if (user.disabledAt) {
    await recordAttempt(db, email, input.ipAddress, false, "account_disabled");
    throw new DomainError("ACCOUNT_DISABLED", "This account has been disabled");
  }

  /*
   * §12.1 — "require MFA on all admin accounts".
   *
   * Enforced as: an admin with no enrolled secret cannot log in at all, rather
   * than being waved through. A soft version of this rule ("prompt them to
   * enrol later") leaves the highest-value accounts on password-only auth for
   * exactly as long as someone postpones it.
   */
  if (user.role === "admin") {
    if (!user.mfaSecret || !user.mfaEnrolledAt) {
      await recordAttempt(db, email, input.ipAddress, false, "admin_mfa_not_enrolled");
      throw new DomainError(
        "MFA_ENROLMENT_REQUIRED",
        "Admin accounts must complete MFA enrolment before signing in",
      );
    }
    if (!input.totpCode) {
      await recordAttempt(db, email, input.ipAddress, false, "mfa_required");
      throw new DomainError("MFA_REQUIRED", "A verification code is required");
    }

    const counter = matchedTotpCounter(user.mfaSecret, input.totpCode);
    if (counter === undefined) {
      await recordAttempt(db, email, input.ipAddress, false, "mfa_failed");
      throw new DomainError("MFA_INVALID", "Invalid verification code");
    }

    /*
     * Single-use enforcement. A code is a fixed function of its 30-second
     * step, so `verifyTotp` alone would accept the SAME code again and again
     * until it aged out of the ±90s window — a shoulder-surfed or
     * log-leaked code stays live for a stranger the whole time. The
     * conditional UPDATE is what makes this safe under concurrency too: two
     * requests racing the same code can both pass the signature check above,
     * but only one can win this WHERE clause, so only one issues a session.
     */
    const consumed = await db
      .update(users)
      .set({ mfaLastUsedCounter: counter })
      .where(
        and(
          eq(users.id, user.id),
          or(isNull(users.mfaLastUsedCounter), lt(users.mfaLastUsedCounter, counter)),
        ),
      )
      .returning({ id: users.id });

    if (consumed.length === 0) {
      await recordAttempt(db, email, input.ipAddress, false, "mfa_replayed");
      throw new DomainError("MFA_INVALID", "Invalid verification code");
    }
  }

  await recordAttempt(db, email, input.ipAddress, true, "success");

  return issueTokenPair(db, config, {
    userId: user.id,
    role: user.role,
    mfaSatisfied: user.role !== "admin" || Boolean(input.totpCode),
    familyId: randomUUID(),
    ...(input.ipAddress !== undefined && { ipAddress: input.ipAddress }),
    ...(input.userAgent !== undefined && { userAgent: input.userAgent }),
  });
}

interface IssueInput {
  readonly userId: string;
  readonly role: UserRole;
  readonly mfaSatisfied: boolean;
  readonly familyId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

async function issueTokenPair(
  db: Database,
  config: AuthConfig,
  input: IssueInput,
): Promise<TokenPair> {
  const refreshToken = generateRefreshToken();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sessionId = randomUUID();

  await db.insert(sessions).values({
    id: sessionId,
    userId: input.userId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    familyId: input.familyId,
    expiresAt: new Date(Date.now() + config.refreshTokenTtlSeconds * 1000),
    ...(input.ipAddress !== undefined && { ipAddress: input.ipAddress }),
    ...(input.userAgent !== undefined && { userAgent: input.userAgent }),
  });

  const claims: AccessTokenClaims = {
    sub: input.userId,
    role: input.role,
    iat: nowSeconds,
    exp: nowSeconds + config.accessTokenTtlSeconds,
    sid: sessionId,
    mfa: input.mfaSatisfied,
  };

  return {
    accessToken: signAccessToken(claims, config.secret),
    refreshToken,
    expiresIn: config.accessTokenTtlSeconds,
    userId: input.userId,
    role: input.role,
  };
}

/**
 * Exchanges a refresh token for a new pair, rotating the old one.
 *
 * Reuse detection: presenting an already-rotated token means either it was
 * stolen and replayed, or the legitimate client is replaying. There is no way
 * to distinguish the two, so the safe response is to revoke the whole family
 * and force a fresh login. Without this, a thief who refreshes once holds a
 * valid credential for the full refresh TTL and nothing ever notices.
 */
export async function refresh(
  db: Database,
  config: AuthConfig,
  refreshToken: string,
  context: { readonly ipAddress?: string; readonly userAgent?: string } = {},
): Promise<TokenPair> {
  const tokenHash = hashRefreshToken(refreshToken);

  const [session] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      familyId: sessions.familyId,
      issuedAt: sessions.issuedAt,
      expiresAt: sessions.expiresAt,
      rotatedAt: sessions.rotatedAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, tokenHash))
    .limit(1);

  if (!session) {
    throw new DomainError("INVALID_REFRESH_TOKEN", "Invalid refresh token");
  }

  if (session.rotatedAt) {
    // Replay of a spent token. Burn the family.
    await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: "token_reuse_detected" })
      .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)));

    throw new DomainError(
      "REFRESH_TOKEN_REUSED",
      "This session has been revoked. Please sign in again.",
      { familyId: session.familyId },
    );
  }

  if (session.revokedAt || session.expiresAt <= new Date()) {
    throw new DomainError("INVALID_REFRESH_TOKEN", "Invalid refresh token");
  }

  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      disabledAt: users.disabledAt,
      sessionsValidFrom: users.sessionsValidFrom,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user || user.disabledAt) {
    throw new DomainError("ACCOUNT_DISABLED", "This account has been disabled");
  }

  /*
   * §12.1 — session invalidation on password change.
   *
   * A watermark comparison rather than a mass DELETE: one UPDATE to
   * users.sessions_valid_from invalidates every session issued before it,
   * including ones on devices that are offline right now and will present
   * their token later.
   */
  if (session.issuedAt < user.sessionsValidFrom) {
    throw new DomainError(
      "SESSION_INVALIDATED",
      "This session is no longer valid. Please sign in again.",
    );
  }

  await db
    .update(sessions)
    .set({ rotatedAt: new Date() })
    .where(eq(sessions.id, session.id));

  return issueTokenPair(db, config, {
    userId: user.id,
    role: user.role,
    /*
     * A live session can only exist if MFA was satisfied when it was created —
     * `login` refuses to issue one to an admin otherwise. Rotation therefore
     * inherits that fact rather than re-deriving it, and an admin does not
     * silently drop to a non-MFA session an hour after signing in.
     */
    mfaSatisfied: true,
    familyId: session.familyId,
    ...(context.ipAddress !== undefined && { ipAddress: context.ipAddress }),
    ...(context.userAgent !== undefined && { userAgent: context.userAgent }),
  });
}

/**
 * §12.1 — changing a password logs the user out everywhere.
 *
 * Both halves matter: the watermark stops tokens that already exist, and the
 * explicit revoke closes sessions that would otherwise linger in the table
 * until expiry.
 */
export async function changePassword(
  db: Database,
  userId: string,
  newPassword: string,
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, sessionsValidFrom: now, updatedAt: now })
      .where(eq(users.id, userId));

    await tx
      .update(sessions)
      .set({ revokedAt: now, revokedReason: "password_changed" })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  });
}

export async function logout(db: Database, refreshToken: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: "logout" })
    .where(eq(sessions.refreshTokenHash, hashRefreshToken(refreshToken)));
}

/** Revokes every live session for a user — used by admin account suspension. */
export async function revokeAllSessions(
  db: Database,
  userId: string,
  reason: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason.slice(0, 60) })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

async function assertNotLockedOut(
  db: Database,
  config: AuthConfig,
  identifier: string,
): Promise<void> {
  const since = new Date(Date.now() - config.lockoutWindowSeconds * 1000);

  const [row] = await db
    .select({ failures: sql<number>`count(*)::int` })
    .from(authAttempts)
    .where(
      and(
        eq(authAttempts.identifier, identifier),
        eq(authAttempts.successful, "false"),
        gte(authAttempts.createdAt, since),
      ),
    );

  if ((row?.failures ?? 0) >= config.maxFailedAttempts) {
    throw new DomainError(
      "TOO_MANY_ATTEMPTS",
      "Too many failed sign-in attempts. Please try again later.",
    );
  }
}

async function recordAttempt(
  db: Database,
  identifier: string,
  ipAddress: string | undefined,
  successful: boolean,
  outcome: string,
): Promise<void> {
  await db.insert(authAttempts).values({
    identifier,
    successful: successful ? "true" : "false",
    outcome,
    ...(ipAddress !== undefined && { ipAddress }),
  });
}
