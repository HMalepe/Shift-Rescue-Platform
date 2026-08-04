import type { FastifyInstance } from "fastify";
import { eq, sql, type SQLWrapper } from "drizzle-orm";
import { whatsappMessageLog, type Database } from "@locum/db";
import { withIdempotency } from "@locum/core";
import { isValidTwilioSignature } from "./signature";
import type { Config } from "../config";

/**
 * Twilio status-callback fields we act on. Twilio sends more; anything not
 * listed is ignored rather than rejected, because Meta and Twilio both add
 * fields over time and a stricter parser would start 400-ing on a vendor
 * change we did not ask for.
 */
interface TwilioStatusPayload {
  readonly MessageSid?: string;
  readonly SmsSid?: string;
  readonly MessageStatus?: string;
  readonly SmsStatus?: string;
  readonly ErrorCode?: string;
  readonly Price?: string;
}

/**
 * Monotonic ordering of delivery states. A message only ever moves forward
 * through these, so an out-of-order callback is detectable.
 */
const STATUS_ORDER = [
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "undelivered",
] as const;

type MessageStatus = (typeof STATUS_ORDER)[number];

/**
 * Twilio's vocabulary is wider than ours: `accepted` and `sending` are
 * intermediate states we collapse rather than model separately.
 */
const STATUS_MAP: Readonly<Record<string, MessageStatus>> = {
  queued: "queued",
  accepted: "queued",
  sending: "sent",
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
  undelivered: "undelivered",
};

export function registerTwilioStatusWebhook(
  app: FastifyInstance,
  deps: { readonly db: Database; readonly config: Config },
): void {
  const { db, config } = deps;

  app.post("/webhooks/twilio/status", async (request, reply) => {
    const params = (request.body ?? {}) as Record<string, string>;
    const payload = params as TwilioStatusPayload;

    /*
     * Signature first, before anything is read from the body or written.
     *
     * §12.1 lists third-party webhook handling under security review scope,
     * and this endpoint is world-reachable by construction.
     */
    if (config.TWILIO_AUTH_TOKEN) {
      const url = `${config.PUBLIC_BASE_URL}/webhooks/twilio/status`;
      const signature = request.headers["x-twilio-signature"];
      const valid = isValidTwilioSignature(
        config.TWILIO_AUTH_TOKEN,
        url,
        params,
        typeof signature === "string" ? signature : undefined,
      );

      if (!valid) {
        request.log.warn({ url }, "rejected Twilio webhook: bad signature");
        // 403, deliberately not 401: there is no credential to re-present, and
        // a 401 would invite Twilio to retry a request that can never succeed.
        return reply.code(403).send({ error: "invalid signature" });
      }
    } else if (config.NODE_ENV === "production") {
      // Belt-and-braces with assertProductionReady, which should have stopped
      // boot. If both are somehow bypassed, fail closed rather than accepting
      // unverified writes.
      request.log.error("TWILIO_AUTH_TOKEN unset in production");
      return reply.code(500).send({ error: "misconfigured" });
    }

    // §11.5 — the dedupe key is Twilio's SID. SmsSid is the legacy alias and
    // is still sent for some message types.
    const sid = payload.MessageSid ?? payload.SmsSid;
    if (!sid) {
      return reply.code(400).send({ error: "missing MessageSid" });
    }

    const rawStatus = payload.MessageStatus ?? payload.SmsStatus ?? "";
    const status = STATUS_MAP[rawStatus];
    if (!status) {
      // Unknown status: acknowledge so Twilio stops retrying, but record
      // nothing. Retrying would not make the status recognisable.
      request.log.warn({ sid, rawStatus }, "unknown Twilio message status");
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const outcome = await withIdempotency(
      db,
      { scope: "twilio.status", key: sid, payload: params },
      async () => {
        /*
         * Status callbacks can arrive out of order — `delivered` after `read`
         * happens routinely under retries. The update is therefore guarded so
         * a later-arriving earlier status cannot walk the record backwards.
         *
         * Ordering is by the position in STATUS_ORDER rather than by arrival
         * time, because arrival time is exactly what is unreliable here.
         */
        await db
          .update(whatsappMessageLog)
          .set({
            status,
            statusUpdatedAt: new Date(),
            ...(payload.ErrorCode ? { errorCode: payload.ErrorCode } : {}),
            ...(payload.Price
              ? { priceCents: Math.round(Math.abs(Number(payload.Price)) * 100) }
              : {}),
          })
          .where(
            sql`${whatsappMessageLog.twilioSid} = ${sid}
                AND ${statusRank(whatsappMessageLog.status)} <= ${STATUS_ORDER.indexOf(status)}`,
          );

        return { sid, status };
      },
    );

    if (outcome.status === "in_flight") {
      /*
       * Another delivery of this same SID is mid-processing. 409 makes Twilio
       * retry; answering 200 would tell it the event is handled while the
       * in-flight attempt might still fail, losing the receipt for good.
       */
      return reply.code(409).send({ error: "processing", sid });
    }

    return reply.code(200).send({
      ok: true,
      sid,
      replayed: outcome.status === "replayed",
    });
  });
}

/**
 * Renders STATUS_ORDER as a SQL CASE expression.
 *
 * Generated rather than hand-written so the SQL ordering cannot drift from the
 * TypeScript one. Two copies of this list would eventually disagree, and the
 * symptom — a status silently refusing to advance — is close to invisible.
 */
function statusRank(column: SQLWrapper) {
  const branches = STATUS_ORDER.map(
    (name, rank) => sql`WHEN ${name} THEN ${rank}`,
  );
  return sql`CASE ${column} ${sql.join(branches, sql` `)} ELSE 0 END`;
}

/** Exported for tests and for the §11.6 spend dashboard. */
export async function getMessageStatus(db: Database, sid: string) {
  const [row] = await db
    .select({
      status: whatsappMessageLog.status,
      priceCents: whatsappMessageLog.priceCents,
      errorCode: whatsappMessageLog.errorCode,
    })
    .from(whatsappMessageLog)
    .where(eq(whatsappMessageLog.twilioSid, sid))
    .limit(1);
  return row;
}
