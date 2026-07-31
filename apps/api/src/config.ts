import { z } from "zod";

/**
 * Environment is parsed once at boot and fails loudly if anything is missing.
 *
 * The alternative — reading `process.env.X` at the call site — defers the
 * failure to the first request that happens to touch that code path. For the
 * Twilio webhook secret in particular that would mean discovering a
 * misconfiguration when a real delivery receipt arrives and gets rejected,
 * which looks like a Twilio problem rather than a deploy problem.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ENVIRONMENT: z.string().default("local"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),

  /**
   * §11.5 — used to validate X-Twilio-Signature on inbound webhooks.
   *
   * Optional so the service can boot locally without Twilio credentials, but
   * `assertProductionReady` below refuses to let that state reach production:
   * an unset secret means signature validation is skipped, which turns the
   * webhook into an unauthenticated write endpoint.
   */
  TWILIO_AUTH_TOKEN: z.string().optional(),
  /** Public base URL, needed because Twilio signs the full request URL. */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  /** §12.1 — rate limiting on public endpoints. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * A much tighter limit for /auth/login specifically (§12.1). The global
   * limit keeps the service up; this one makes password guessing impractical,
   * and those goals need very different numbers.
   */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Signing key for access tokens. Rotating it invalidates every issued token.
   * Required — there is no safe default for a signing secret.
   */
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid environment:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Refuses to start in production with a configuration that is only safe
 * locally. Called from main.ts before the server listens.
 */
export function assertProductionReady(
  config: Config,
  runtime: {
    /** True when the in-memory storage / stub scanner are in use. */
    readonly usingStubDocumentDeps?: boolean;
  } = {},
): void {
  if (config.NODE_ENV !== "production") return;

  const problems: string[] = [];

  /*
   * §12.1 requires uploads to be "scanned for malware before storage". The
   * stub scanner detects only EICAR, and the in-memory store loses everything
   * on restart. Booting production with either is worse than having no upload
   * feature at all, because the admin queue would present unscanned documents
   * as though they had passed.
   */
  if (runtime.usingStubDocumentDeps) {
    problems.push(
      "document storage/scanner are the in-memory stubs — wire real S3 and a malware scanner before production",
    );
  }

  if (!config.TWILIO_AUTH_TOKEN) {
    problems.push(
      "TWILIO_AUTH_TOKEN is unset — inbound webhook signatures would not be verified",
    );
  }
  if (config.PUBLIC_BASE_URL.startsWith("http://")) {
    problems.push("PUBLIC_BASE_URL must be https in production");
  }

  if (problems.length > 0) {
    throw new Error(
      `refusing to start in production:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
  }
}
