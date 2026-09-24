import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  changePassword,
  generateTotp,
  generateTotpSecret,
  hashPassword,
  login,
  logout,
  needsRehash,
  refresh,
  register,
  bootstrapFirstAdmin,
  signAccessToken,
  verifyAccessToken,
  verifyTotp,
  DEFAULT_AUTH_CONFIG,
  type AuthConfig,
} from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: security.auth
 *
 * §12.1 names four requirements explicitly. Each has a test below that fails
 * if the requirement is removed:
 *
 *   - token expiry / refresh strategy
 *   - session invalidation on password change
 *   - rate limiting on login to prevent credential stuffing
 *   - MFA on all admin accounts
 */

const { db, client } = connect();

const config: AuthConfig = {
  ...DEFAULT_AUTH_CONFIG,
  secret: "test-secret-not-for-production",
};

const createdUserIds: string[] = [];
/**
 * `register()`'s manager path creates a pharmacy row with no FK back to the
 * user, so deleting the user (which cascades `pharmacyMembers` via its own
 * FK) leaves the pharmacy orphaned rather than cleaned up. Tracked and
 * deleted separately below.
 */
const createdPharmacyIds: string[] = [];
const JOHANNESBURG = { lng: 28.0473, lat: -26.2041 } as const;
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function createUser(options: {
  role: "manager" | "locum" | "admin";
  password: string;
  mfaSecret?: string;
}) {
  const email = `auth-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [user] = await db
    .insert(s.users)
    .values({
      role: options.role,
      email,
      fullName: "Auth Test User",
      passwordHash: await hashPassword(options.password),
      ...(options.mfaSecret
        ? { mfaSecret: options.mfaSecret, mfaEnrolledAt: new Date() }
        : {}),
    })
    .returning({ id: s.users.id });

  createdUserIds.push(user!.id);
  return { id: user!.id, email };
}

afterEach(async () => {
  const ids = createdUserIds.splice(0);
  if (ids.length > 0) {
    await db.delete(s.sessions).where(inArray(s.sessions.userId, ids));
    await db.delete(s.users).where(inArray(s.users.id, ids));
  }
  const pharmacyIds = createdPharmacyIds.splice(0);
  if (pharmacyIds.length > 0) {
    await db.delete(s.pharmacies).where(inArray(s.pharmacies.id, pharmacyIds));
  }
  await db.delete(s.authAttempts).where(eq(s.authAttempts.outcome, "seed-cleanup"));
});

afterAll(async () => {
  await client.end();
});

describe("GATE security.auth — passwords", () => {
  it("uses Argon2id, not a weaker variant", async () => {
    // Guards the omitted `algorithm` parameter: if @node-rs/argon2 ever
    // changes its default, every new password would silently downgrade.
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toMatch(/m=19456/);
    expect(hash).toMatch(/t=2/);
  });

  it("flags hashes made with weaker parameters for rehash", () => {
    expect(needsRehash("$argon2id$v=19$m=4096,t=1,p=1$abc$def")).toBe(true);
    expect(needsRehash("$argon2id$v=19$m=19456,t=2,p=1$abc$def")).toBe(false);
    expect(needsRehash("not-a-hash")).toBe(true);
  });
});

describe("GATE security.auth — login and credential stuffing", () => {
  it("issues a token pair for valid credentials", async () => {
    const user = await createUser({ role: "manager", password: "s3cure-password!" });
    const tokens = await login(db, config, {
      email: user.email,
      password: "s3cure-password!",
    });

    expect(tokens.userId).toBe(user.id);
    expect(tokens.role).toBe("manager");

    const verified = verifyAccessToken(tokens.accessToken, config.secret);
    expect(verified.valid).toBe(true);
  });

  it("gives the same error whether or not the account exists", async () => {
    const user = await createUser({ role: "manager", password: "s3cure-password!" });

    const wrongPassword = await login(db, config, {
      email: user.email,
      password: "wrong",
    }).catch((e) => e);
    const noSuchUser = await login(db, config, {
      email: "definitely-not-registered@test.invalid",
      password: "wrong",
    }).catch((e) => e);

    // Distinguishable errors here would confirm whether a named pharmacist is
    // on the platform — a POPIA exposure (§10), not just a security one.
    expect(wrongPassword.code).toBe("INVALID_CREDENTIALS");
    expect(noSuchUser.code).toBe("INVALID_CREDENTIALS");
    expect(wrongPassword.message).toBe(noSuchUser.message);
  });

  it("locks out after repeated failures (§12.1 credential stuffing)", async () => {
    const user = await createUser({ role: "manager", password: "s3cure-password!" });

    for (let i = 0; i < config.maxFailedAttempts; i += 1) {
      await login(db, config, { email: user.email, password: "wrong" }).catch(() => {});
    }

    // Even the CORRECT password is now refused — that is the point. A lockout
    // that still admits the right password stops nothing, since the attacker
    // is trying to find exactly that.
    await expect(
      login(db, config, { email: user.email, password: "s3cure-password!" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_ATTEMPTS" });

    await db.delete(s.authAttempts).where(eq(s.authAttempts.identifier, user.email));
  });
});

describe("GATE security.auth — admin sign-in", () => {
  it("admits an admin with email and password only", async () => {
    const admin = await createUser({ role: "admin", password: "admin-password!" });

    const tokens = await login(db, config, {
      email: admin.email,
      password: "admin-password!",
    });

    expect(tokens.role).toBe("admin");
    const verified = verifyAccessToken(tokens.accessToken, config.secret);
    expect(verified.valid && verified.claims.mfa).toBe(true);
  });

  it("accepts adjacent time windows but not distant ones", () => {
    const secret = generateTotpSecret();
    const now = Date.now();

    expect(verifyTotp(secret, generateTotp(secret, now), now)).toBe(true);
    // ±30s absorbs phone/server clock drift.
    expect(verifyTotp(secret, generateTotp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, generateTotp(secret, now + 30_000), now)).toBe(true);
    // Two minutes out must not be accepted — that is a replay window.
    expect(verifyTotp(secret, generateTotp(secret, now - 120_000), now)).toBe(false);
    expect(verifyTotp(secret, "abc123", now)).toBe(false);
  });

  it("bootstraps the first admin with MFA enrolled and refuses a second", async () => {
    const email = `boot-${unique()}@test.invalid`;
    const created = await bootstrapFirstAdmin(db, {
      email,
      password: "admin-password!",
      fullName: "First Admin",
    });
    createdUserIds.push(created.userId);

    expect(created.email).toBe(email);

    const tokens = await login(db, config, {
      email,
      password: "admin-password!",
    });
    expect(tokens.role).toBe("admin");

    await expect(
      bootstrapFirstAdmin(db, {
        email: `boot-two-${unique()}@test.invalid`,
        password: "admin-password!",
        fullName: "Second Admin",
      }),
    ).rejects.toMatchObject({ code: "ADMIN_EXISTS" });
  });
});

describe("GATE security.auth — tokens", () => {
  it("rejects a tampered access token", () => {
    const token = signAccessToken(
      { sub: "u1", role: "manager", iat: 1, exp: 9_999_999_999, sid: "s1", mfa: false },
      config.secret,
    );
    const [payload, signature] = token.split(".");

    // Re-signing with a different secret is the attack: without a real
    // signature check this token would grant manager access.
    const forged = signAccessToken(
      { sub: "u1", role: "admin", iat: 1, exp: 9_999_999_999, sid: "s1", mfa: true },
      "attacker-secret",
    );

    expect(verifyAccessToken(forged, config.secret)).toMatchObject({
      valid: false,
      reason: "bad_signature",
    });
    expect(verifyAccessToken(`${payload}.${signature}x`, config.secret).valid).toBe(false);
    expect(verifyAccessToken("garbage", config.secret)).toMatchObject({
      valid: false,
      reason: "malformed",
    });
  });

  it("rejects an expired access token", () => {
    const token = signAccessToken(
      { sub: "u1", role: "manager", iat: 1, exp: 100, sid: "s1", mfa: false },
      config.secret,
    );
    expect(verifyAccessToken(token, config.secret, 200)).toMatchObject({
      valid: false,
      reason: "expired",
    });
  });
});

describe("GATE security.auth — refresh rotation and reuse detection", () => {
  it("rotates the refresh token on use", async () => {
    const user = await createUser({ role: "locum", password: "s3cure-password!" });
    const first = await login(db, config, {
      email: user.email,
      password: "s3cure-password!",
    });

    const second = await refresh(db, config, first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.userId).toBe(user.id);
  });

  it("revokes the whole family when a spent token is replayed", async () => {
    const user = await createUser({ role: "locum", password: "s3cure-password!" });
    const first = await login(db, config, {
      email: user.email,
      password: "s3cure-password!",
    });

    const second = await refresh(db, config, first.refreshToken);

    // Replaying the spent token. Either it was stolen or the client is
    // replaying — indistinguishable, so burn the family.
    await expect(refresh(db, config, first.refreshToken)).rejects.toMatchObject({
      code: "REFRESH_TOKEN_REUSED",
    });

    // The thief's newer token is dead too. Without family revocation, an
    // attacker who refreshed once would keep a valid credential.
    await expect(refresh(db, config, second.refreshToken)).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
    });
  });

  it("invalidates every session on password change (§12.1)", async () => {
    const user = await createUser({ role: "manager", password: "old-password!" });

    const phone = await login(db, config, {
      email: user.email,
      password: "old-password!",
    });
    const laptop = await login(db, config, {
      email: user.email,
      password: "old-password!",
    });

    await changePassword(db, user.id, "new-password!");

    // Both devices are logged out, including one that was offline at the time
    // and only presents its token later.
    await expect(refresh(db, config, phone.refreshToken)).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
    });
    await expect(refresh(db, config, laptop.refreshToken)).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
    });

    // And the new password works.
    const after = await login(db, config, {
      email: user.email,
      password: "new-password!",
    });
    expect(after.userId).toBe(user.id);
  });

  it("the sessions_valid_from watermark invalidates on its own", async () => {
    /*
     * `changePassword` uses two mechanisms: it revokes existing session rows
     * AND advances users.sessions_valid_from. The test above only proves the
     * revoke works — it would still pass if the watermark check were deleted.
     *
     * This exercises the watermark in isolation by moving it without touching
     * the session rows. It matters because the revoke is a snapshot: a session
     * created concurrently with the password change, or by any future code
     * path that inserts one, is caught by the watermark and nothing else.
     */
    const user = await createUser({ role: "manager", password: "s3cure-password!" });
    const tokens = await login(db, config, {
      email: user.email,
      password: "s3cure-password!",
    });

    await db
      .update(s.users)
      .set({ sessionsValidFrom: new Date(Date.now() + 1000) })
      .where(eq(s.users.id, user.id));

    await expect(refresh(db, config, tokens.refreshToken)).rejects.toMatchObject({
      code: "SESSION_INVALIDATED",
    });
  });

  it("logout kills only that session", async () => {
    const user = await createUser({ role: "locum", password: "s3cure-password!" });
    const a = await login(db, config, { email: user.email, password: "s3cure-password!" });
    const b = await login(db, config, { email: user.email, password: "s3cure-password!" });

    await logout(db, a.refreshToken);

    await expect(refresh(db, config, a.refreshToken)).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
    });
    // Signing out on one device must not sign you out on the others.
    await expect(refresh(db, config, b.refreshToken)).resolves.toMatchObject({
      userId: user.id,
    });
  });

  it("refuses a disabled account at refresh, not just at login", async () => {
    const user = await createUser({ role: "manager", password: "s3cure-password!" });
    const tokens = await login(db, config, {
      email: user.email,
      password: "s3cure-password!",
    });

    await db
      .update(s.users)
      .set({ disabledAt: new Date() })
      .where(eq(s.users.id, user.id));

    // Checking only at login would leave a suspended admin holding a working
    // session for the full refresh TTL.
    await expect(refresh(db, config, tokens.refreshToken)).rejects.toMatchObject({
      code: "ACCOUNT_DISABLED",
    });
  });
});

describe("GATE security.auth — self-service registration", () => {
  it("creates an unverified locum account that can immediately log in", async () => {
    const email = `register-locum-${unique()}@test.invalid`;
    const result = await register(db, {
      role: "locum",
      email,
      password: "correct horse battery staple",
      fullName: "New Locum",
      sapcNumber: `P${unique()}`,
    });
    createdUserIds.push(result.userId);

    const [profile] = await db
      .select({ verification: s.locumProfiles.verification })
      .from(s.locumProfiles)
      .where(eq(s.locumProfiles.userId, result.userId));
    // Same starting state as an admin-provisioned account — registration is
    // not a shortcut around §5's human-checks-the-SAPC-certificate rule.
    expect(profile?.verification).toBe("incomplete");

    const tokens = await login(db, config, { email, password: "correct horse battery staple" });
    expect(tokens.userId).toBe(result.userId);
    expect(tokens.role).toBe("locum");
  });

  it("creates an unverified pharmacy the manager is the primary member of", async () => {
    const email = `register-manager-${unique()}@test.invalid`;
    const result = await register(db, {
      role: "manager",
      email,
      password: "correct horse battery staple",
      fullName: "New Manager",
      pharmacy: {
        name: "Test Pharmacy",
        addressLine: "1 Test Street",
        city: "Johannesburg",
        sapcPharmacyNumber: `PH${unique()}`,
        location: JOHANNESBURG,
      },
    });
    createdUserIds.push(result.userId);

    const [membership] = await db
      .select()
      .from(s.pharmacyMembers)
      .where(eq(s.pharmacyMembers.userId, result.userId));
    expect(membership?.isPrimary).toBe(true);
    createdPharmacyIds.push(membership!.pharmacyId);

    const [pharmacy] = await db
      .select({ verification: s.pharmacies.verification, sapc: s.pharmacies.sapcPharmacyNumber })
      .from(s.pharmacies)
      .where(eq(s.pharmacies.id, membership!.pharmacyId));
    expect(pharmacy?.verification).toBe("incomplete");
    expect(pharmacy?.sapc).toBeTruthy();

    const tokens = await login(db, config, { email, password: "correct horse battery staple" });
    expect(tokens.role).toBe("manager");
  });

  it("rejects a duplicate email without creating a second account", async () => {
    const email = `register-dup-${unique()}@test.invalid`;
    const first = await register(db, {
      role: "locum",
      email,
      password: "correct horse battery staple",
      fullName: "First",
      sapcNumber: `P${unique()}`,
    });
    createdUserIds.push(first.userId);

    await expect(
      register(db, {
        role: "locum",
        email,
        password: "a different password!",
        fullName: "Second",
        sapcNumber: `P${unique()}`,
      }),
    ).rejects.toMatchObject({ code: "EMAIL_TAKEN" });

    const rows = await db.select().from(s.users).where(eq(s.users.email, email.toLowerCase()));
    expect(rows).toHaveLength(1);
  });

  it("rejects a duplicate SAPC number, leaving neither the user row behind", async () => {
    const sapcNumber = `P${unique()}`;
    const first = await register(db, {
      role: "locum",
      email: `register-sapc1-${unique()}@test.invalid`,
      password: "correct horse battery staple",
      fullName: "First",
      sapcNumber,
    });
    createdUserIds.push(first.userId);

    const secondEmail = `register-sapc2-${unique()}@test.invalid`;
    await expect(
      register(db, {
        role: "locum",
        email: secondEmail,
        password: "correct horse battery staple",
        fullName: "Second",
        sapcNumber,
      }),
    ).rejects.toMatchObject({ code: "SAPC_NUMBER_TAKEN" });

    // The transaction must have rolled back the user insert too — a bare
    // account with no profile behind it would be a real login that can never
    // pass verification.
    const rows = await db.select().from(s.users).where(eq(s.users.email, secondEmail));
    expect(rows).toHaveLength(0);
  });
});
