import type { FastifyInstance } from "fastify";
import {
  activateSubscription,
  postbackValidate,
  verifyItnSignature,
  withIdempotency,
} from "@locum/core";
import type { Database } from "@locum/db";
import type { Config } from "../config";

/**
 * Payfast's Instant Transaction Notification for the Subscribe flow.
 *
 * Two independent checks gate this before a single row is written, per
 * Payfast's own integration guide: the MD5 signature over the fields AS
 * POSTED, and a mandatory postback to Payfast's own server asking it to
 * confirm the transaction. Signature alone is explicitly documented by
 * Payfast as insufficient — see `verifyItnSignature`'s comment.
 *
 * §15: G -> X. There is no live Payfast sandbox to have actually sent this
 * route a real ITN yet, so the exact field list Payfast posts for a
 * `subscription_type=2` tokenize transaction is the first thing to verify
 * once sandbox access exists — this implements Payfast's documented shape,
 * not a shape confirmed against a live delivery.
 */
export function registerPayfastItnWebhook(
  app: FastifyInstance,
  deps: {
    readonly db: Database;
    readonly config: Config;
    /** Overridable so tests can stub Payfast's postback-validate call. */
    readonly fetchImpl?: typeof fetch;
  },
): void {
  const { db, config, fetchImpl } = deps;

  app.post("/webhooks/payfast/itn", async (request, reply) => {
    const params = (request.body ?? {}) as Record<string, string>;

    if (!config.PAYFAST_PASSPHRASE) {
      // Belt-and-braces with assertProductionReady, which should have
      // stopped boot. Fail closed rather than accept an unverifiable ITN.
      request.log.error("PAYFAST_PASSPHRASE unset — refusing ITN");
      return reply.code(500).send({ error: "misconfigured" });
    }

    /*
     * `@fastify/formbody` parses into a plain object rather than handing back
     * the raw bytes. Payfast's signature is over the fields AS POSTED, not
     * re-sorted — this relies on `params`' iteration order matching POST
     * order, which holds for `application/x-www-form-urlencoded` bodies
     * parsed by both Node's `querystring` and `fast-querystring` (what
     * formbody uses under the hood): string-keyed object iteration follows
     * insertion order, and insertion happens in parse order. If that parser
     * ever changes, this needs a raw-body content-type parser instead.
     */
    const orderedFields = Object.entries(params);

    if (!verifyItnSignature(orderedFields, config.PAYFAST_PASSPHRASE)) {
      request.log.warn("rejected Payfast ITN: bad signature");
      // 400, not 403: there is no credential to re-present and this is not
      // an authorization decision, it is "this request is not from Payfast".
      return reply.code(400).send({ error: "invalid signature" });
    }

    const confirmed = await postbackValidate(new URLSearchParams(params).toString(), {
      ...(config.PAYFAST_ITN_HOST !== undefined && { host: config.PAYFAST_ITN_HOST }),
      ...(fetchImpl !== undefined && { fetchImpl }),
    });
    if (!confirmed) {
      request.log.warn("rejected Payfast ITN: postback-validate did not confirm");
      return reply.code(400).send({ error: "not confirmed by payfast" });
    }

    const subscriptionId = params["custom_str1"];
    const paymentStatus = params["payment_status"];
    const pfPaymentId = params["pf_payment_id"];
    // Payfast's own examples are inconsistent about which field carries the
    // reusable billing token for a tokenize-only transaction — some show
    // `token`, others fold it into `pf_payment_id`. Both are accepted; this
    // is exactly the kind of detail that needs confirming against a live
    // sandbox delivery (see the file comment).
    const mandateToken = params["token"] ?? pfPaymentId;
    const amountGross = params["amount_gross"];

    if (!subscriptionId || !pfPaymentId || !mandateToken) {
      request.log.warn({ params }, "Payfast ITN missing required fields");
      return reply.code(400).send({ error: "missing required fields" });
    }

    if (paymentStatus !== "COMPLETE") {
      // Acknowledge so Payfast stops retrying; there is nothing to activate
      // for a cancelled/failed/pending tokenize attempt.
      return reply.code(200).send({ ok: true, ignored: true, paymentStatus });
    }

    const amountCents = amountGross ? Math.round(Number(amountGross) * 100) : 0;
    const now = new Date();

    const outcome = await withIdempotency(
      db,
      { scope: "payfast.itn", key: pfPaymentId, payload: params },
      async () =>
        activateSubscription(db, {
          subscriptionId,
          mandateToken,
          amountCents,
          payfastTxnRef: pfPaymentId,
          periodStart: now,
          periodEnd: new Date(now.getTime() + 30 * 86_400_000),
        }),
    );

    if (outcome.status === "in_flight") {
      return reply.code(409).send({ error: "processing", pfPaymentId });
    }

    return reply.code(200).send({ ok: true, replayed: outcome.status === "replayed" });
  });
}
