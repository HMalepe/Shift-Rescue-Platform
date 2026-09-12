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

  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),

  /**
   * §11.5 — used to validate X-Twilio-Signature on inbound webhooks.
   *
   * Optional so the service can boot locally without Twilio credentials, but
   * `assertProductionReady` below refuses to let that state reach production:
   * an unset secret means signature validation is skipped, which turns the
   * webhook into an unauthenticated write endpoint.
   */
  TWILIO_AUTH_TOKEN: z.string().trim().optional(),
  /** Public base URL, needed because Twilio signs the full request URL. */
  PUBLIC_BASE_URL: z.string().trim().url().default("http://localhost:3000"),

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
  AUTH_SECRET: z.string().trim().min(32, "AUTH_SECRET must be at least 32 characters"),

  /**
   * §0.1 — where alerts go. Sentry, PagerDuty Events, Opsgenie, a Slack hook:
   * anything that accepts a JSON POST. Optional so the service boots locally
   * without one; `assertProductionReady` refuses to let that reach production,
   * because a service that silently drops its own alerts looks monitored and
   * is not.
   */
  ALERT_WEBHOOK_URL: z.string().trim().url().optional(),
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
  TWILIO_ACCOUNT_SID: z.string().trim().optional(),
  TWILIO_FROM_NUMBER: z.string().trim().optional(),
  TWILIO_CONTENT_SIDS: z
    .string()
    .trim()
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
  CLAMD_HOST: z.string().trim().optional(),
  CLAMD_PORT: z.coerce.number().int().positive().default(3310),

  /**
   * §5/§10 — where verification documents live.
   *
   * All optional so the service boots locally on the in-memory store. Two
   * S3-compatible providers are supported: AWS itself (`infra/`, `S3_SSE_MODE
   * =aws-kms`, requires `S3_KMS_KEY_ID`) and Cloudflare R2 for the Railway MVP
   * path (`S3_SSE_MODE=provider-managed`, requires `S3_ENDPOINT`, no KMS key —
   * R2 encrypts every object at rest under a key it manages itself and has no
   * bucket-side equivalent of a customer KMS key to send).
   *
   * `S3_SSE_MODE` has no default. An unset value means storage falls back to
   * the in-memory stub rather than guessing a mode — silently defaulting to
   * `provider-managed` the moment a bucket name appears is exactly the kind of
   * inferred security posture this file has otherwise refused to allow.
   */
  S3_BUCKET: z.string().trim().optional(),
  S3_REGION: z.string().trim().default("af-south-1"),
  S3_SSE_MODE: z.enum(["aws-kms", "provider-managed"]).optional(),
  S3_KMS_KEY_ID: z.string().trim().optional(),
  /** Set for R2/MinIO; unset targets AWS S3 directly. */
  S3_ENDPOINT: z.string().trim().optional(),
  AWS_ACCESS_KEY_ID: z.string().trim().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().trim().optional(),

  /**
   * Phase 1 launches to locums paid directly by their own pharmacy/HR — the
   * platform charges nobody and touches no money yet. `canPostShifts`
   * (packages/core/src/billing/dunning.ts) blocks a pharmacy with no
   * subscription row at all, which is *every* pharmacy in phase 1 — without
   * this flag, no manager could ever post a shift. Off by default so a
   * deploy that never sets it launches in the state phase 1 actually needs;
   * flipping it on is phase 3's whole job, not a code change. Every Payfast
   * integration stays wired and gated by `assertProductionReady` exactly as
   * before — this flag only decides whether `shifts.create` enforces what it
   * finds, not whether the billing code exists.
   */
  BILLING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * §2 — Payfast tokenization ("Subscribe"). All three required together; a
   * merchant id/key pair with no passphrase signs every request wrong rather
   * than failing loudly, so `assertProductionReady` treats a partial set the
   * same as none at all.
   */
  PAYFAST_MERCHANT_ID: z.string().trim().optional(),
  PAYFAST_MERCHANT_KEY: z.string().trim().optional(),
  PAYFAST_PASSPHRASE: z.string().trim().optional(),
  /** Hosted checkout page the browser is redirected to. */
  PAYFAST_PROCESS_URL: z.string().trim().url().optional(),
  /**
   * Where Payfast redirects the manager's BROWSER after paying — the Vercel
   * dashboard, not this API. `PUBLIC_BASE_URL` above is a different thing: it
   * is what Payfast calls server-to-server for the ITN, and always this API.
   * Conflating the two would send a manager's browser to a bare JSON API
   * after checkout instead of back to the dashboard.
   */
  DASHBOARD_BASE_URL: z.string().trim().url().default("http://localhost:3001"),
  /** ITN postback-validate host — see `.env.example` for why this is not a boolean. */
  PAYFAST_ITN_HOST: z.string().trim().url().optional(),
  /**
   * §2's flat monthly fee. No figure is fixed in the product spec, so this is
   * a configuration value rather than a hardcoded constant — R899 is a
   * placeholder used throughout this codebase's tests, not a pricing decision
   * anyone has actually made.
   */
  SUBSCRIPTION_MONTHLY_CENTS: z.coerce.number().int().positive().default(89_900),
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
   * §2 — a production API with no Payfast credentials cannot sign a Subscribe
   * redirect at all. This is deliberately caught here rather than left to
   * fail at the first manager who tries to subscribe: same reasoning as every
   * other guard in this function.
   */
  const payfastConfigured =
    config.PAYFAST_MERCHANT_ID !== undefined &&
    config.PAYFAST_MERCHANT_KEY !== undefined &&
    config.PAYFAST_PASSPHRASE !== undefined;
  if (!payfastConfigured) {
    problems.push(
      "PAYFAST_MERCHANT_ID / PAYFAST_MERCHANT_KEY / PAYFAST_PASSPHRASE are not all set — the Subscribe flow cannot sign a redirect",
    );
  }

  /*
   * §12.1 requires uploads to be "scanned for malware before storage". The
   * stub scanner detects only EICAR, and the in-memory store loses everything
   * on restart. Booting production with either is worse than having no upload
   * feature at all, because the admin queue would present unscanned documents
   * as though they had passed.
   */
  if (runtime.usingStubStorage) {
    problems.push(
      "document storage is InMemoryDocumentStorage — set S3_BUCKET, S3_SSE_MODE (and " +
        "S3_KMS_KEY_ID if aws-kms) plus AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY to wire the real adapter",
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
