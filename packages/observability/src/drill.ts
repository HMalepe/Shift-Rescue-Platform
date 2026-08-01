/**
 * §0.1 — the deliberately broken endpoint.
 *
 * Phase 0's exit criterion, verbatim: *"a deliberately broken endpoint on
 * staging produces an alert, and the load harness runs end-to-end against
 * seeded data, before Phase 1 feature work is considered started."*
 *
 * The load harness half has been runnable since Phase 0. This is the other
 * half, and it was skipped — every phase since was built on an alerting path
 * nobody had ever fired. That is worth stating rather than quietly fixing:
 * the whole point of an exit criterion is that it is checked before, not
 * after.
 *
 * ## Why this is dangerous and how it is contained
 *
 * An endpoint that throws on request is, from a distance, a denial-of-service
 * primitive with a friendly name. Three independent controls, because any one
 * of them alone fails in a way the others cover:
 *
 *   1. **Never enabled in production by default.** It requires an explicit
 *      environment variable, so shipping the code is not shipping the hazard.
 *   2. **Authenticated by a shared secret**, compared in constant time. An
 *      unauthenticated drill endpoint on staging is an open invitation to
 *      generate alerts until the team stops reading them — which is a way of
 *      disabling monitoring, not just of being noisy.
 *   3. **Rate limited to one firing at a time**, so a held-down key cannot
 *      become a flood. A drill that pages fifty times has proven only that
 *      the pager works, and cost the goodwill needed for the next real page.
 *
 * The drill deliberately throws a plain `Error` rather than a DomainError.
 * `classify` routes DomainErrors to `routine`, and a drill that quietly failed
 * to page because it used a tidy error code would be a test of nothing.
 */

export const DRILL_PATH = "/__drill/boom";

/** Thrown by the drill, so it is identifiable in the alert. */
export class DrillError extends Error {
  constructor(note: string) {
    super(`Phase 0 alerting drill: ${note}`);
    this.name = "DrillError";
  }
}

export interface DrillConfig {
  readonly enabled: boolean;
  /** Compared in constant time against the caller's header. */
  readonly secret: string | undefined;
  /** Minimum gap between firings. */
  readonly cooldownMs?: number;
}

export type DrillOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly status: 404 | 401 | 429; readonly reason: string };

/**
 * Decides whether a drill request may fire.
 *
 * Pure, and separate from any HTTP framework, so the gating is testable
 * without standing up a server — the controls above are the entire safety
 * argument for shipping this file, and they should not be reachable only
 * through an integration test.
 */
export class DrillGate {
  private readonly config: DrillConfig;
  /*
   * `undefined`, not 0. Zero means "fired at the epoch", and `now - 0` is
   * enormous under a real clock — so the first firing works by accident and
   * fails the moment a clock is injected. The distinction between "never
   * fired" and "fired long ago" has to be represented, not inferred from
   * arithmetic that happens to be true in production.
   */
  private lastFiredAt: number | undefined;

  constructor(config: DrillConfig) {
    this.config = config;
  }

  check(presentedSecret: string | undefined, now = Date.now()): DrillOutcome {
    /*
     * 404, not 403, when disabled. A disabled drill should be indistinguishable
     * from an endpoint that does not exist — 403 confirms the path is real and
     * tells someone to come back with a credential.
     */
    if (!this.config.enabled || this.config.secret === undefined) {
      return { allowed: false, status: 404, reason: "drill_disabled" };
    }

    if (!timingSafeEqual(presentedSecret ?? "", this.config.secret)) {
      return { allowed: false, status: 401, reason: "bad_secret" };
    }

    const cooldown = this.config.cooldownMs ?? 60_000;
    if (this.lastFiredAt !== undefined && now - this.lastFiredAt < cooldown) {
      return { allowed: false, status: 429, reason: "cooling_down" };
    }

    this.lastFiredAt = now;
    return { allowed: true };
  }
}

/**
 * Constant-time string comparison.
 *
 * Hand-rolled rather than `crypto.timingSafeEqual` because that throws on
 * length mismatch, and the throw itself leaks the length. Comparing every
 * character of the longer string keeps the work constant regardless.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}
