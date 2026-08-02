import * as SecureStore from "expo-secure-store";

/**
 * The mobile API client.
 *
 * ## Why this cannot reuse the web client's approach
 *
 * `apps/web` is a back-end-for-front-end: tokens live in httpOnly cookies and
 * the browser never sees them. That is not available here — there is no server
 * between this app and the API, so the token has to live on the device.
 *
 * `expo-secure-store` is the least-bad place for it: the iOS Keychain and
 * Android's EncryptedSharedPreferences, both backed by hardware-held keys on
 * modern devices. That is genuinely better than `localStorage` on the web, and
 * it is worth being precise about *why* rather than treating "we used the
 * secure API" as the end of the argument: it survives a hostile app on the
 * same device, and it does not survive a rooted or jailbroken one. §12.1's
 * short access-token lifetime and refresh rotation are what limit the damage
 * in that case, not this module.
 *
 * ## Refresh
 *
 * Serialised on a module-level promise, for the same reason as the web client:
 * the API treats a *reused* refresh token as evidence of theft and kills the
 * session (§12.1). Two screens refreshing in parallel would each present the
 * same token and the second would look exactly like an attacker replaying a
 * stolen one — logging the user out for the crime of opening two tabs.
 *
 * That risk is higher here than on the web, not lower: a mobile app resumes
 * from background with several screens mounted at once, all of them holding an
 * expired token.
 */

const ACCESS_KEY = "lp_access_token";
const REFRESH_KEY = "lp_refresh_token";

export class ApiError extends Error {
  readonly status: number;
  readonly domainCode: string | undefined;

  constructor(status: number, message: string, domainCode?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.domainCode = domainCode;
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("not signed in");
    this.name = "UnauthenticatedError";
  }
}

export interface ApiConfig {
  readonly baseUrl: string;
}

let config: ApiConfig = { baseUrl: "http://localhost:3000" };

export function configureApi(next: ApiConfig): void {
  config = next;
}

export async function readTokens(): Promise<{
  accessToken: string | null;
  refreshToken: string | null;
}> {
  const [accessToken, refreshToken] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_KEY),
    SecureStore.getItemAsync(REFRESH_KEY),
  ]);
  return { accessToken, refreshToken };
}

export async function storeTokens(tokens: {
  accessToken: string;
  refreshToken: string;
}): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
    SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
  ]);
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
  ]);
}

interface TrpcEnvelope<T> {
  result?: { data: T };
  error?: { message: string; data?: { httpStatus?: number; domainCode?: string } };
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshSession(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const { refreshToken } = await readTokens();
    if (!refreshToken) return null;

    const response = await fetch(`${config.baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      // Expired, revoked, or flagged as reused — all three mean the session is
      // over. Clearing stops the app retrying a dead token on every screen.
      await clearTokens();
      return null;
    }

    const tokens = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    await storeTokens(tokens);
    return tokens.accessToken;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function once<T>(
  path: string,
  method: "GET" | "POST",
  body: unknown,
  token: string | null,
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string; domainCode?: string }> {
  const url =
    method === "GET"
      ? `${config.baseUrl}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(body ?? {}))}`
      : `${config.baseUrl}/trpc/${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });

  const envelope = (await response.json()) as TrpcEnvelope<T>;

  if (!response.ok || envelope.error) {
    const failure: { ok: false; status: number; message: string; domainCode?: string } = {
      ok: false,
      status: envelope.error?.data?.httpStatus ?? response.status,
      message: envelope.error?.message ?? "request failed",
    };
    if (envelope.error?.data?.domainCode !== undefined) {
      failure.domainCode = envelope.error.data.domainCode;
    }
    return failure;
  }

  return { ok: true, data: envelope.result!.data };
}

async function call<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const { accessToken } = await readTokens();
  let attempt = await once<T>(path, method, body, accessToken);

  if (!attempt.ok && attempt.status === 401) {
    const refreshed = await refreshSession();
    if (!refreshed) throw new UnauthenticatedError();
    attempt = await once<T>(path, method, body, refreshed);
  }

  if (!attempt.ok) {
    if (attempt.status === 401) throw new UnauthenticatedError();
    throw new ApiError(attempt.status, attempt.message, attempt.domainCode);
  }

  return attempt.data;
}

export const api = {
  query: <T>(path: string, input?: unknown) => call<T>(path, "GET", input),
  mutate: <T>(path: string, input?: unknown) => call<T>(path, "POST", input),
};

export async function signIn(input: {
  email: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await fetch(`${config.baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    // The API returns the same message for an unknown address and a wrong
    // password. Not improved on here — a friendlier message would rebuild the
    // account-enumeration oracle the API avoids being.
    return { ok: false, message: payload.error ?? "Could not sign in" };
  }

  await storeTokens(
    (await response.json()) as { accessToken: string; refreshToken: string },
  );
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const { refreshToken } = await readTokens();
  if (refreshToken) {
    await fetch(`${config.baseUrl}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => undefined);
  }
  await clearTokens();
}
