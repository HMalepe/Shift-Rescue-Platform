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

  /**
   * §0.1 — where alerts go. Sentry, PagerDuty Events, Opsgenie, a Slack hook:
   * anything that accepts a JSON POST. Optional so the service boots locally
   * without one; `assertProductionReady` refuses to let that reach production,
   * because a service that silently drops its own alerts looks monitored and
   * is not.
   */
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  ALERT_MIN_SEVERITY: z.enum(["routine", "warn", "page"]).default("warn"),
  /** Commit SHA, so an alert can be tied to a deploy. */
  RELEASE: z.string().optional(),

  /**
   * §0.1's deliberately broken endpoint. Off unless BOTH of these are set —
   * shipping the code must not ship the hazard.
   */
  DRILL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DRILL_SECRET: z.string().min(16).optional(),

  /**
   * §11.1/§12.3 — the outbound WhatsApp sender.
   *
   * All three are needed together, and `assertProductionReady` refuses the
   * fake in production. Content SIDs arrive as JSON because they do not exist
   * until Meta approves each template (§15, externally blocked), so they
   * cannot be hard-coded; a missing SID makes the adapter throw rather than
   * silently downgrade to a free-form send.
   */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_CONTENT_SIDS: z
    .string()
    .default("{}")
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as Record<string, string>;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "TWILIO_CONTENT_SIDS must be JSON, e.g. {\"shift_offer_v1\":\"HX...\"}",
        });
        return z.NEVER;
      }
    }),

  /**
   * §12.1 — the malware scanner. clamd, reached over TCP.
   *
   * Optional so the service boots locally on the stub, and refused in
   * production by `assertProductionReady` for the reason §12.1 gives: an
   * upload path that stores unscanned files is worse than no upload path,
   * because the admin queue presents them as having passed.
   */
  CLAMD_HOST: z.string().optional(),
  CLAMD_PORT: z.coerce.number().int().positive().default(3310),

  /**
   * §5/§10 — where verification documents live.
   *
   * All optional so the service boots locally on the in-memory store, but the
   * KMS key is not separately optional in spirit: the S3 adapter's constructor
   * refuses without it, because these objects are SAPC certificates and ID
   * documents. A bucket configured with no key fails at boot rather than
   * storing plaintext identity documents.
   */
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("af-south-1"),
  S3_KMS_KEY_ID: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
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
    /**
     * These were ONE flag until the S3 adapter landed, and that was fine only
     * while both were stubbed. They are separate facts now: storage can be
     * real while the scanner is still the EICAR stub, and a single flag would
     * be satisfied by wiring S3 — reporting the whole document pipeline as
     * production-ready while nothing is scanning uploads. §12.1 requires
     * scanning before storage, so the check that matters is the one that would
     * have been silently switched off.
     */
    readonly usingStubStorage?: boolean;
    readonly usingStubScanner?: boolean;
    /**
     * §12.3 — the API sends WhatsApp now.
     *
     * It did not until the Phase 3 fan-out landed: every message came from the
     * worker, which has always had this guard. The "Looking for a Locum"
     * toggle fires ring 0 inline, so the API acquired a sender and needs the
     * same refusal. `FakeWhatsAppSender` marks every message sent, reports
     * healthy, and delivers nothing — a manager would be told their regulars
     * had been notified when nobody had.
     */
    readonly usingFakeWhatsAppSender?: boolean;
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
  if (runtime.usingStubStorage) {
    problems.push(
      "document storage is InMemoryDocumentStorage — set S3_BUCKET/S3_KMS_KEY_ID to wire the real adapter",
    );
  }
  if (runtime.usingStubScanner) {
    problems.push(
      "document scanner is StubDocumentScanner, which detects only EICAR — wire a real malware scanner before production (§12.1)",
    );
  }

  if (runtime.usingFakeWhatsAppSender) {
    problems.push(
      "WhatsApp sender is FakeWhatsAppSender — the §12.3 fan-out would report notifying locums who were never messaged",
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

  /*
   * §0.1. Booting production with no alert sink is worse than having no
   * alerting story at all: the code paths exist, the dashboards look wired,
   * and every incident is discarded silently.
   */
  if (!config.ALERT_WEBHOOK_URL) {
    problems.push(
      "ALERT_WEBHOOK_URL is unset — errors would be logged and never alerted on",
    );
  }

  /*
   * The drill is a staging tool. In production it is an endpoint whose entire
   * function is to break, and no amount of gating makes that worth shipping to
   * users.
   */
  if (config.DRILL_ENABLED) {
    problems.push("DRILL_ENABLED must not be true in production");
  }

  if (problems.length > 0) {
    throw new Error(
      `refusing to start in production:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
  }
}
