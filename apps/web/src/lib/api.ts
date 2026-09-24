import "server-only";
import { readTokens, storeTokens, clearTokens } from "./session";

/**
 * A minimal typed tRPC-over-HTTP caller, running only on the server.
 *
 * Deliberately not `@trpc/client` + React Query. That stack exists to move
 * data into the *browser*, and this app moves none: every call is made from a
 * Server Component or a Server Action, so there is no cache to hydrate, no
 * query keys to invalidate, and no client bundle to ship. `revalidatePath`
 * covers what invalidation there is.
 *
 * End-to-end types still hold — `AppRouter` is imported as a type from
 * `@locum/api` and nothing from that package is bundled.
 */

const API_URL = process.env["API_URL"] ?? "http://localhost:3000";

export class ApiError extends Error {
  readonly status: number;
  /** The API's own domain code (`SHIFT_ALREADY_FILLED`, …) where present. */
  readonly domainCode: string | undefined;

  constructor(status: number, message: string, domainCode?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.domainCode = domainCode;
  }
}

/** Thrown when the session is gone; the layout turns this into a redirect. */
export class UnauthenticatedError extends Error {
  constructor() {
    super("not signed in");
    this.name = "UnauthenticatedError";
  }
}

interface TrpcEnvelope<T> {
  result?: { data: T };
  error?: {
    message: string;
    data?: { httpStatus?: number; domainCode?: string };
  };
}

async function callOnce<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; token: string | undefined },
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string; domainCode?: string }> {
  const url =
    init.method === "GET"
      ? `${API_URL}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(init.body ?? {}))}`
      : `${API_URL}/trpc/${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.method === "POST" ? { body: JSON.stringify(init.body ?? {}) } : {}),
      // Every read is per-request. A shift board cached across users would show
      // one pharmacy's applicants to another, which is the worst possible bug to
      // introduce for a performance gain nobody asked for.
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, status: 503, message: "API unreachable" };
  }

  const envelope = (await response.json()) as TrpcEnvelope<T>;

  if (!response.ok || envelope.error) {
    const result: { ok: false; status: number; message: string; domainCode?: string } = {
      ok: false,
      status: envelope.error?.data?.httpStatus ?? response.status,
      message: envelope.error?.message ?? "request failed",
    };
    if (envelope.error?.data?.domainCode !== undefined) {
      result.domainCode = envelope.error.data.domainCode;
    }
    return result;
  }

  return { ok: true, data: envelope.result!.data };
}

/**
 * Exchanges the refresh token for a new pair.
 *
 * The API rotates on every refresh and treats a *reused* refresh token as
 * evidence of theft, killing the whole session (§12.1). That makes concurrent
 * refreshes genuinely dangerous rather than merely wasteful: two Server
 * Components rendering in parallel, both seeing a 401, would each present the
 * same refresh token and the second would look exactly like an attacker
 * replaying a stolen one — logging the user out for being logged in twice.
 *
 * Serialising on a module-level promise fixes it within a process. It is not a
 * distributed lock and does not need to be: the loser of a cross-process race
 * still has a working session, because the winner already wrote fresh cookies
 * and the retry below picks them up.
 */
let refreshInFlight: Promise<string | undefined> | undefined;

export async function refreshSession(): Promise<string | undefined> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const { refreshToken } = await readTokens();
    if (!refreshToken) return undefined;

    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return undefined;
      }

      const tokens = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
      };
      await storeTokens(tokens);
      return tokens.accessToken;
    } catch {
      return undefined;
    }
  })().finally(() => {
    refreshInFlight = undefined;
  });

  return refreshInFlight;
}

async function call<T>(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<T> {
  const { accessToken } = await readTokens();

  let attempt = await callOnce<T>(path, { method, body, token: accessToken });

  if (!attempt.ok && attempt.status === 401) {
    const refreshed = await refreshSession();
    if (!refreshed) throw new UnauthenticatedError();
    attempt = await callOnce<T>(path, { method, body, token: refreshed });
  }

  if (!attempt.ok) {
    if (attempt.status === 401) throw new UnauthenticatedError();
    throw new ApiError(attempt.status, attempt.message, attempt.domainCode);
  }

  return attempt.data;
}

/** tRPC queries are GET; mutations are POST. */
export const api = {
  query: <T>(path: string, input?: unknown) => call<T>(path, "GET", input),
  mutate: <T>(path: string, input?: unknown) => call<T>(path, "POST", input),
};

/** Signs in against the API's REST auth route and stores the session. */
export async function signIn(input: {
  email: string;
  password: string;
  totpCode?: string;
}): Promise<{ ok: true } | { ok: false; message: string; domainCode?: string }> {
  try {
    const response = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return { ok: false, ...(await parseAuthFailure(response)) };

    await storeTokens((await response.json()) as { accessToken: string; refreshToken: string });
    return { ok: true };
  } catch {
    return { ok: false, message: "API unreachable" };
  }
}

/**
 * Every REST auth route (`/auth/login`, `/auth/register`) that fails sends
 * one of two shapes: a domain error is `{ error: <code>, message: <human
 * text> }` (`sendDomainError` in `apps/api/src/routes/auth.ts`), a request
 * that never reached domain logic — failed `zod` validation, an unhandled
 * exception — is just `{ error: <human text> }` with no `message` at all.
 * `message` is only ever present on the first shape, so its presence is what
 * tells the two apart; there is no third field name to check.
 */
async function parseAuthFailure(
  response: Response,
): Promise<{ message: string; domainCode?: string }> {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  const result: { message: string; domainCode?: string } = {
    message: payload.message ?? payload.error ?? "Something went wrong",
  };
  if (payload.message !== undefined && payload.error !== undefined) {
    result.domainCode = payload.error;
  }
  return result;
}

export type RegisterInput =
  | {
      role: "locum";
      email: string;
      password: string;
      fullName: string;
      sapcNumber: string;
    }
  | {
      role: "manager";
      email: string;
      password: string;
      fullName: string;
      pharmacyName: string;
      addressLine: string;
      area: string;
      sapcPharmacyNumber: string;
    };

/** Creates an account against the API's REST auth route and, on success,
 *  stores the session exactly like `signIn` — registering signs you in. */
export async function register(
  input: RegisterInput,
): Promise<{ ok: true } | { ok: false; message: string; domainCode?: string }> {
  const response = await fetch(`${API_URL}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) return { ok: false, ...(await parseAuthFailure(response)) };

  await storeTokens((await response.json()) as { accessToken: string; refreshToken: string });
  return { ok: true };
}

export async function fetchSetupStatus(): Promise<{ available: boolean }> {
  try {
    const response = await fetch(`${API_URL}/auth/setup-status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { available: false };
    const body = (await response.json()) as { available?: boolean };
    return { available: body.available === true };
  } catch {
    return { available: false };
  }
}

export async function bootstrapAdminAccount(input: {
  email: string;
  password: string;
  fullName: string;
}): Promise<
  | { ok: true; email: string; mfaSecret: string; otpauthUrl: string }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${API_URL}/auth/bootstrap-admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return { ok: false, ...(await parseAuthFailure(response)) };

    const body = (await response.json()) as {
      email: string;
      mfaSecret: string;
      otpauthUrl: string;
    };
    return { ok: true, ...body };
  } catch {
    return { ok: false, message: "API unreachable" };
  }
}

export async function signOut(): Promise<void> {
  const { refreshToken } = await readTokens();
  if (refreshToken) {
    // Best-effort: the cookies are cleared regardless. A network failure here
    // must not leave someone appearing signed in on a shared machine.
    await fetch(`${API_URL}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      cache: "no-store",
    }).catch(() => undefined);
  }
  await clearTokens();
}
