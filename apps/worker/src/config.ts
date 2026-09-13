import { z } from "zod";

/**
 * Worker environment, parsed once at boot.
 *
 * Same reasoning as the API's config: a scheduled job that discovers a missing
 * variable on its first firing fails at 07:00 on a Saturday, in a process
 * nobody is watching, and looks like a Twilio outage rather than a deploy
 * problem.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ENVIRONMENT: z.string().default("local"),

  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
  /**
   * Deliberately smaller than the API's pool.
   *
   * The measured numbers in packages/db/src/client.ts are unambiguous: raising
   * the pool made booking confirmation *slower* under contention, because a
   * wider pool means more sessions queueing on the same row locks. The worker
   * is a batch process with no user waiting on it, so it gets the smaller
   * share — its latency does not matter and the API's does.
   */
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5),

  REDIS_URL: z.string().default("redis://localhost:6379"),

  /**
   * How often the quiet-hours queue is swept.
   *
   * A minute is far more often than §4.4 needs — the backlog is due at 07:00
   * and nothing else creates work during the day. It is cheap (one indexed
   * query returning nothing) and it means a message deferred to 07:00 goes out
   * at 07:00, not at 07:59.
   */
  DRAIN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  DRAIN_BATCH_SIZE: z.coerce.number().int().positive().default(50),

  /**
   * Dunning runs hourly. The retry ladder is measured in days (24h/72h/168h),
   * so anything finer is wasted work; anything coarser starts to smear the
   * ladder's own timing.
   */
  DUNNING_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  DUNNING_BATCH_SIZE: z.coerce.number().int().positive().default(100),

  /** §11.6 — soft daily cap. Alerts, never blocks. */
  WHATSAPP_DAILY_SPEND_CAP_CENTS: z.coerce.number().int().positive().optional(),

  TWILIO_ACCOUNT_SID: z.string().trim().optional(),
  TWILIO_AUTH_TOKEN: z.string().trim().optional(),
  /**
   * The sender number. Canonical here already — this config has always used
   * this name — but `TWILIO_FROM_NUMBER` (what apps/api's config used to
   * require for the identical value) is accepted too, purely as a legacy
   * alias: on Railway, variables are copied to each service by hand rather
   * than shared, and requiring different names on the two services for one
   * setting was a footgun with no upside. See apps/api/src/config.ts's
   * matching comment.
   */
  TWILIO_WHATSAPP_FROM: z.string().trim().optional(),
  /** @deprecated legacy alias for `TWILIO_WHATSAPP_FROM` — see its comment. */
  TWILIO_FROM_NUMBER: z.string().trim().optional(),
  /** §11.5 — where delivery receipts are posted back. */
  TWILIO_STATUS_CALLBACK_URL: z.string().trim().url().optional(),
  /**
   * §11.2 — template name to Twilio Content SID, as JSON.
   *
   * Configuration rather than code: the SIDs do not exist until Meta approves
   * each template, which §15 lists as externally blocked. Hard-coding them
   * would mean a deploy for every approval.
   */
  TWILIO_CONTENT_SIDS: z
    .string()
    .trim()
    .default("{}")
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as Record<string, string>;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be valid JSON" });
        return z.NEVER;
      }
    }),

  PAYFAST_MERCHANT_ID: z.string().trim().optional(),
  PAYFAST_MERCHANT_KEY: z.string().trim().optional(),
  /**
   * Required for signed calls in practice even though Payfast lists it as
   * optional — see the note on `PayfastConfig.passphrase`. Without it, every
   * signature this worker sends is simply wrong, and Payfast rejects it
   * looking like a credentials problem rather than a missing setting.
   */
  PAYFAST_PASSPHRASE: z.string().trim().optional(),
  /**
   * Overrides the adhoc-billing API host, for a sandbox account. Left as an
   * explicit URL rather than a PAYFAST_SANDBOX boolean deliberately: this
   * codebase has no live Payfast sandbox access to confirm the exact sandbox
   * hostname against, and guessing one would be worse than requiring it be
   * set from whatever Payfast's own account dashboard actually shows.
   */
  PAYFAST_BASE_URL: z.string().trim().url().optional(),

  /** §0.1 — see apps/api/src/config.ts for the reasoning. */
  ALERT_WEBHOOK_URL: z.string().trim().url().optional(),
  ALERT_MIN_SEVERITY: z.enum(["routine", "warn", "page"]).default("warn"),
  RELEASE: z.string().optional(),
})
  /*
   * Resolves the TWILIO_WHATSAPP_FROM / TWILIO_FROM_NUMBER alias once, here —
   * see apps/api/src/config.ts's matching transform for the full reasoning.
   * TWILIO_FROM_NUMBER is dropped from the parsed result; only the canonical
   * field exists past this point.
   */
  .transform(({ TWILIO_FROM_NUMBER, ...rest }) => ({
    ...rest,
    TWILIO_WHATSAPP_FROM: rest.TWILIO_WHATSAPP_FROM ?? TWILIO_FROM_NUMBER,
  }));

export type WorkerConfig = z.infer<typeof schema>;

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid worker environment:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Refuses to run in production against the fakes.
 *
 * This matters more in the worker than in the API. An API running a fake
 * sender fails visibly the first time someone books a shift. A *worker*
 * running a fake sender drains the queue, marks every row `sent`, and reports
 * healthy — the messages simply never arrive, and the log says they did. That
 * is the exact silent-failure shape §11.3 warns about, arrived at from a
 * different direction.
 */
export function assertWorkerProductionReady(
  config: WorkerConfig,
  runtime: {
    readonly usingFakeSender?: boolean;
    readonly usingFakePaymentProvider?: boolean;
  } = {},
): void {
  if (config.NODE_ENV !== "production") return;

  const problems: string[] = [];

  if (runtime.usingFakeSender) {
    problems.push(
      "WhatsApp sender is the in-memory fake — the drain would mark messages sent that were never sent",
    );
  }
  if (runtime.usingFakePaymentProvider) {
    problems.push(
      "payment provider is the in-memory fake — dunning would settle charges that were never charged",
    );
  }

  /*
   * §0.1. The worker needs this MORE than the API does: an API with no
   * alerting still has users who complain, and a worker has nobody at all.
   */
  if (!config.ALERT_WEBHOOK_URL) {
    problems.push(
      "ALERT_WEBHOOK_URL is unset — a failing scheduled job would fail silently forever",
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `refusing to start worker in production:\n${problems
        .map((p) => `  ${p}`)
        .join("\n")}`,
    );
  }
}
