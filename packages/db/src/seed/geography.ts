import type { LngLat } from "../types/geography";

/**
 * Real Gauteng population/retail centres, with a rough weight and a spread in
 * kilometres describing how tightly pharmacies and pharmacists cluster around
 * each one.
 *
 * §14 is explicit about why this matters:
 *
 *   "clustered around Gauteng metro density, not uniformly random. Uniform
 *    random coordinates make proximity queries look artificially
 *    well-distributed and hide the index behaviour being observed."
 *
 * The failure mode is concrete. Spread 5,000 locums evenly over a bounding box
 * and any given 15 km radius returns a handful of rows, so the planner happily
 * uses the GiST index and every query looks fast. Cluster them the way people
 * actually live and a Sandton radius query can match several hundred — which
 * is where sort cost, LIMIT behaviour and the fan-out in §12.3 actually start
 * to hurt. Seeding the easy distribution would mean the §15 `EXPLAIN ANALYZE`
 * gate passes against data that does not resemble production.
 *
 * Coordinates are approximate centroids; precision beyond ~1 km is irrelevant
 * for load-shape purposes.
 */
export interface MetroCentre {
  readonly name: string;
  readonly lng: number;
  readonly lat: number;
  /** Relative share of the population drawn from this centre. */
  readonly weight: number;
  /** Standard deviation of the surrounding scatter, in kilometres. */
  readonly spreadKm: number;
}

export const GAUTENG_CENTRES: readonly MetroCentre[] = [
  { name: "Johannesburg CBD", lng: 28.0473, lat: -26.2041, weight: 14, spreadKm: 5 },
  { name: "Sandton", lng: 28.0567, lat: -26.1076, weight: 16, spreadKm: 4 },
  { name: "Randburg", lng: 28.0059, lat: -26.0936, weight: 9, spreadKm: 5 },
  { name: "Roodepoort", lng: 27.8725, lat: -26.1625, weight: 8, spreadKm: 6 },
  { name: "Soweto", lng: 27.8546, lat: -26.2678, weight: 13, spreadKm: 7 },
  { name: "Midrand", lng: 28.1263, lat: -25.9992, weight: 7, spreadKm: 5 },
  { name: "Pretoria CBD", lng: 28.1881, lat: -25.7479, weight: 11, spreadKm: 6 },
  { name: "Centurion", lng: 28.1878, lat: -25.8603, weight: 8, spreadKm: 5 },
  { name: "Kempton Park", lng: 28.2294, lat: -26.1000, weight: 6, spreadKm: 5 },
  { name: "Benoni", lng: 28.3208, lat: -26.1885, weight: 5, spreadKm: 5 },
  { name: "Boksburg", lng: 28.2294, lat: -26.2125, weight: 5, spreadKm: 4 },
  { name: "Germiston", lng: 28.1590, lat: -26.2178, weight: 5, spreadKm: 4 },
  { name: "Vereeniging", lng: 27.9319, lat: -26.6731, weight: 4, spreadKm: 6 },
  { name: "Krugersdorp", lng: 27.7749, lat: -26.0855, weight: 4, spreadKm: 6 },
  { name: "Alberton", lng: 28.1220, lat: -26.2672, weight: 4, spreadKm: 4 },
  { name: "Tembisa", lng: 28.2265, lat: -25.9964, weight: 6, spreadKm: 4 },
];

/**
 * Deterministic PRNG (mulberry32).
 *
 * `Math.random()` would make every seed run produce a different dataset, so a
 * query plan captured as evidence for the §15 gate could never be reproduced
 * or compared against a later run. A fixed seed means "the plan changed" is
 * always a real signal about the schema rather than noise about the data.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller: uniform -> standard normal, so scatter is Gaussian not square. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const KM_PER_DEGREE_LAT = 110.574;

export function pickCentre(
  rng: () => number,
  centres: readonly MetroCentre[] = GAUTENG_CENTRES,
): MetroCentre {
  const total = centres.reduce((sum, c) => sum + c.weight, 0);
  let target = rng() * total;
  for (const centre of centres) {
    target -= centre.weight;
    if (target <= 0) return centre;
  }
  // Unreachable barring float drift; the last centre is a safe fallback.
  return centres[centres.length - 1]!;
}

/**
 * Scatters a point around a centre with Gaussian spread.
 *
 * Longitude degrees converge toward the poles, so the east-west conversion is
 * scaled by cos(latitude). At Gauteng's ~26°S that is a ~10% correction —
 * small, but it would otherwise stretch every cluster east-west and quietly
 * distort the distance distribution the load test is meant to exercise.
 */
export function scatterAround(rng: () => number, centre: MetroCentre): LngLat {
  const latOffsetKm = gaussian(rng) * centre.spreadKm;
  const lngOffsetKm = gaussian(rng) * centre.spreadKm;

  const lat = centre.lat + latOffsetKm / KM_PER_DEGREE_LAT;
  const kmPerDegreeLng = KM_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  const lng = centre.lng + lngOffsetKm / kmPerDegreeLng;

  return { lng, lat };
}

export function randomGautengPoint(rng: () => number): LngLat {
  return scatterAround(rng, pickCentre(rng));
}
