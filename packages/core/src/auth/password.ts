import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id, at the OWASP-recommended floor: 19 MiB memory, 2 iterations,
 * parallelism 1.
 *
 * Argon2id rather than bcrypt or PBKDF2 because it is memory-hard — the cost
 * of a GPU or ASIC cracking rig scales with RAM, not just clock cycles. This
 * database holds SAPC registration numbers, ID documents and payslips (§12.1),
 * so a stolen dump is worth real effort to an attacker and the password hashes
 * are the thing standing between them and every account.
 *
 * `@node-rs/argon2` ships prebuilt binaries, so there is no compiler in the
 * deploy path.
 *
 * These parameters are recorded inside the hash string itself, so raising them
 * later does not invalidate existing hashes — `verify` reads the cost from the
 * stored value. `needsRehash` below is how a gradual upgrade is performed.
 */
/*
 * `algorithm` is deliberately not passed. @node-rs/argon2 defaults to
 * Argon2id, and its `Algorithm` enum is an ambient const enum that cannot be
 * imported under `verbatimModuleSyntax` without a build-time inline. Rather
 * than hardcode the magic value 2, the default is relied on and *asserted* —
 * a test checks that produced hashes carry the `$argon2id$` prefix, so a
 * future upstream change of default fails the suite instead of silently
 * downgrading every password to Argon2d.
 */
const PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length === 0) {
    throw new Error("refusing to hash an empty password");
  }
  return hash(plaintext, PARAMS);
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash. A user row with a
 * corrupt hash must fail closed as "wrong password", not crash the login
 * endpoint — a crash is both an outage and an oracle telling an attacker that
 * this particular account is interesting.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    return false;
  }
}

/**
 * A dummy hash with the real cost parameters, used to equalise timing on the
 * "no such user" path.
 *
 * Without this, a login for a non-existent email returns in microseconds while
 * a real account takes ~50ms of Argon2 work. That difference is trivially
 * measurable over the network and turns the login endpoint into a user
 * enumeration oracle — which for this product means confirming whether a named
 * pharmacist is registered on the platform, a POPIA problem (§10) as much as a
 * security one.
 */
let dummyHashPromise: Promise<string> | undefined;

export function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("locum-planner-timing-equalisation-dummy");
  return dummyHashPromise;
}

/** True when a stored hash was made with weaker parameters than current policy. */
export function needsRehash(storedHash: string): boolean {
  const memory = /m=(\d+)/.exec(storedHash);
  const time = /t=(\d+)/.exec(storedHash);
  if (!memory?.[1] || !time?.[1]) return true;
  return (
    Number(memory[1]) < PARAMS.memoryCost || Number(time[1]) < PARAMS.timeCost
  );
}
