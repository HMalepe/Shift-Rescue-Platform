import { and, asc, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  locumProfiles,
  pharmacies,
  pharmacyMembers,
  shifts,
  users,
  type Database,
  type LngLat,
} from "@locum/db";
import { sendWhatsAppMessage, type DashboardNotifyDeps } from "./send";

/**
 * A `geography` column deserialises to a plain `{ lng, lat }` once selected —
 * it is no longer SQL, so it cannot be spliced into a later `ST_DWithin` call
 * without this. Same conversion `packages/core/src/attendance/index.ts` and
 * `reputation/service.ts` already do at their own call sites.
 */
function pointSql(point: LngLat): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography`;
}

/**
 * "N locums near you" / "N pharmacies hiring near you" — area-activity
 * nudges, Marketing category (§11.2: these are not a specific match against
 * preferences the recipient set, unlike shift_offer, so they don't qualify as
 * Utility).
 *
 * Two paths deliver the same message type:
 *
 *   - Real-time reciprocal: `notifyNearbyManagers`/`notifyNearbyLocums` fire
 *     immediately when the OTHER side changes state near this one — a locum
 *     going available, or a pharmacy opening a shift.
 *   - Idle digest: `sweepNearbyDigest` is the fallback for someone nothing is
 *     reciprocally telling — it respects each user's own chosen cadence
 *     (`nearbyNudgeFrequency`), never firing more often than that.
 *
 * Both paths stamp `nearbyNudgeLastSentAt`, so a real-time send resets that
 * user's own digest clock — the digest sweep does not immediately re-notify
 * someone who was just told a moment ago through the reciprocal path.
 */

/**
 * Locums counted as "near" a point: currently available (§5 — `availableFrom`
 * set and not in the future), within THEIR OWN stated travel radius of the
 * point. A locum who capped travel at 15km is never counted toward a
 * pharmacy 40km away, same rule `selectRing` enforces for actual matching.
 */
async function nearbyLocumsCount(
  db: Database,
  point: SQL,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(locumProfiles)
    .where(
      and(
        sql`${locumProfiles.availableFrom} is not null`,
        lte(locumProfiles.availableFrom, now),
        sql`${locumProfiles.baseLocation} is not null`,
        sql`ST_DWithin(${locumProfiles.baseLocation}, ${point}, ${locumProfiles.maxTravelKm} * 1000)`,
      ),
    );
  return row?.n ?? 0;
}

/** Distinct pharmacies with at least one open shift within the locum's own travel radius. */
async function nearbyPharmaciesCount(
  db: Database,
  locumId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${shifts.pharmacyId})::int` })
    .from(shifts)
    .innerJoin(locumProfiles, eq(locumProfiles.userId, locumId))
    .where(
      and(
        eq(shifts.status, "open"),
        sql`${locumProfiles.baseLocation} is not null`,
        sql`ST_DWithin(${shifts.location}, ${locumProfiles.baseLocation}, ${locumProfiles.maxTravelKm} * 1000)`,
      ),
    );
  return row?.n ?? 0;
}

/** The pharmacy's one primary manager — same target `new_applicant` and `booking_cancelled` notify. */
async function primaryManagerId(db: Database, pharmacyId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ userId: pharmacyMembers.userId })
    .from(pharmacyMembers)
    .where(and(eq(pharmacyMembers.pharmacyId, pharmacyId), eq(pharmacyMembers.isPrimary, true)))
    .limit(1);
  return row?.userId;
}

/**
 * Real-time reciprocal: a locum just went available. Every pharmacy with an
 * open shift within THIS locum's travel radius gets told, immediately,
 * bypassing the digest cadence entirely.
 */
export async function notifyNearbyManagers(
  db: Database,
  deps: DashboardNotifyDeps,
  input: { readonly locumId: string },
): Promise<{ readonly notified: number }> {
  const now = deps.now?.() ?? new Date();

  const [profile] = await db
    .select({ baseLocation: locumProfiles.baseLocation, maxTravelKm: locumProfiles.maxTravelKm })
    .from(locumProfiles)
    .where(eq(locumProfiles.userId, input.locumId))
    .limit(1);

  if (!profile?.baseLocation) return { notified: 0 };

  const nearbyPharmacies = await db
    .selectDistinct({ pharmacyId: shifts.pharmacyId, location: pharmacies.location })
    .from(shifts)
    .innerJoin(pharmacies, eq(pharmacies.id, shifts.pharmacyId))
    .where(
      and(
        eq(shifts.status, "open"),
        sql`ST_DWithin(${shifts.location}, ${profile.baseLocation}, ${profile.maxTravelKm} * 1000)`,
      ),
    );

  let notified = 0;
  for (const pharmacy of nearbyPharmacies) {
    const managerId = await primaryManagerId(db, pharmacy.pharmacyId);
    if (!managerId) continue;

    const count = await nearbyLocumsCount(db, pointSql(pharmacy.location), now);
    if (count === 0) continue;

    const outcome = await sendWhatsAppMessage(db, deps, {
      type: "locums_nearby",
      userId: managerId,
      variables: [String(count), `${deps.dashboardBaseUrl}/browse`],
    });

    if (outcome.status === "sent" || outcome.status === "deferred") {
      await db.update(users).set({ nearbyNudgeLastSentAt: now }).where(eq(users.id, managerId));
      notified += 1;
    }
  }
  return { notified };
}

/**
 * Real-time reciprocal: a pharmacy just opened a shift. Every currently
 * AVAILABLE locum within that shift's travel radius gets told, immediately.
 *
 * Distinct from `shift_offer`/the ring fan-out: this is a general "there is
 * demand near you" nudge to anyone available, not a specific match against a
 * favourites list or a single shift's own escalation — a locum can receive
 * both for the same shift, and that is intended, not a duplicate.
 */
export async function notifyNearbyLocums(
  db: Database,
  deps: DashboardNotifyDeps,
  input: { readonly shiftId: string },
): Promise<{ readonly notified: number }> {
  const now = deps.now?.() ?? new Date();

  const [shift] = await db
    .select({ location: shifts.location, radiusKm: shifts.radiusKm })
    .from(shifts)
    .where(eq(shifts.id, input.shiftId))
    .limit(1);

  if (!shift) return { notified: 0 };

  const available = await db
    .select({ userId: locumProfiles.userId })
    .from(locumProfiles)
    .where(
      and(
        sql`${locumProfiles.availableFrom} is not null`,
        lte(locumProfiles.availableFrom, now),
        sql`${locumProfiles.baseLocation} is not null`,
        sql`ST_DWithin(${locumProfiles.baseLocation}, ${pointSql(shift.location)}, ${locumProfiles.maxTravelKm} * 1000)`,
      ),
    );

  let notified = 0;
  for (const locum of available) {
    const count = await nearbyPharmaciesCount(db, locum.userId);
    if (count === 0) continue;

    const outcome = await sendWhatsAppMessage(db, deps, {
      type: "pharmacies_nearby",
      userId: locum.userId,
      variables: [String(count), `${deps.dashboardBaseUrl}/browse`],
    });

    if (outcome.status === "sent" || outcome.status === "deferred") {
      await db.update(users).set({ nearbyNudgeLastSentAt: now }).where(eq(users.id, locum.userId));
      notified += 1;
    }
  }
  return { notified };
}

/**
 * Idle digest — the fallback for a user nothing is reciprocally telling.
 * Paged, same termination guarantee as `rolloverDuePeriods`: every user this
 * touches gets `nearbyNudgeLastSentAt` stamped, so a repeated call never
 * re-selects the same due user twice in one sweep.
 */
export async function sweepNearbyDigest(
  db: Database,
  deps: DashboardNotifyDeps,
  opts: { readonly limit?: number; readonly now?: () => Date } = {},
): Promise<{ readonly sent: number }> {
  const now = opts.now?.() ?? new Date();
  const limit = opts.limit ?? 200;

  let sent = 0;
  for (;;) {
    // "Due": frequency isn't `off`, and either never sent or the interval
    // since the last send (real-time or digest, either counts) has elapsed.
    // The interval itself is a CASE over the enum rather than a lookup table
    // join — six values, unlikely to change often enough to earn one.
    const dueClause = or(
      isNull(users.nearbyNudgeLastSentAt),
      sql`${users.nearbyNudgeLastSentAt} <= ${now} - (
        case ${users.nearbyNudgeFrequency}
          when '1h' then interval '1 hour'
          when '2h' then interval '2 hours'
          when '3h' then interval '3 hours'
          when '4h' then interval '4 hours'
          when '6h' then interval '6 hours'
          else interval '24 hours'
        end
      )`,
    );

    const due = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(
        and(
          sql`${users.nearbyNudgeFrequency} <> 'off'`,
          dueClause,
          isNull(users.disabledAt),
          isNull(users.erasedAt),
        ),
      )
      .orderBy(asc(users.nearbyNudgeLastSentAt))
      .limit(limit);

    if (due.length === 0) break;

    for (const user of due) {
      if (user.role === "manager") {
        const [membership] = await db
          .select({ location: pharmacies.location })
          .from(pharmacyMembers)
          .innerJoin(pharmacies, eq(pharmacies.id, pharmacyMembers.pharmacyId))
          .where(and(eq(pharmacyMembers.userId, user.id), eq(pharmacyMembers.isPrimary, true)))
          .limit(1);

        if (membership) {
          const count = await nearbyLocumsCount(db, pointSql(membership.location), now);
          if (count > 0) {
            const outcome = await sendWhatsAppMessage(db, deps, {
              type: "locums_nearby",
              userId: user.id,
              variables: [String(count), `${deps.dashboardBaseUrl}/browse`],
            });
            if (outcome.status === "sent" || outcome.status === "deferred") sent += 1;
          }
        }
      } else if (user.role === "locum") {
        const count = await nearbyPharmaciesCount(db, user.id);
        if (count > 0) {
          const outcome = await sendWhatsAppMessage(db, deps, {
            type: "pharmacies_nearby",
            userId: user.id,
            variables: [String(count), `${deps.dashboardBaseUrl}/browse`],
          });
          if (outcome.status === "sent" || outcome.status === "deferred") sent += 1;
        }
      }

      await db.update(users).set({ nearbyNudgeLastSentAt: now }).where(eq(users.id, user.id));
    }

    if (due.length < limit) break;
  }
  return { sent };
}
