/**
 * Approximate area centroids offered during manager self-registration.
 *
 * There is no address-geocoding integration (a real address → lat/lng lookup
 * needs a paid API or a self-hosted service, neither wired up yet). Asking a
 * manager to supply exact coordinates at signup would be unrealistic, so
 * registration instead asks which of these areas the pharmacy is nearest to
 * and uses that as a starting location — accurate enough for the coarse
 * proximity radius §4/§8 match on, not survey-grade. `profile.updatePharmacy`
 * already lets a manager (or an admin) correct it to an exact point later.
 *
 * Deliberately a separate, small, curated list rather than a reuse of
 * `packages/db/src/seed/geography.ts`'s `GAUTENG_CENTRES` — that list exists
 * to produce a realistic *synthetic load distribution* for §15's query-plan
 * gate, and pulling real registration UX from a load-test fixture would
 * couple two things that should be free to diverge (that file's weights and
 * spread radii have nothing to do with which area name a manager should see
 * in a dropdown).
 */
export interface PharmacyArea {
  readonly name: string;
  readonly city: string;
  readonly lng: number;
  readonly lat: number;
}

export const PHARMACY_AREAS: readonly PharmacyArea[] = [
  { name: "Johannesburg CBD", city: "Johannesburg", lng: 28.0473, lat: -26.2041 },
  { name: "Sandton", city: "Johannesburg", lng: 28.0567, lat: -26.1076 },
  { name: "Randburg", city: "Johannesburg", lng: 28.0059, lat: -26.0936 },
  { name: "Roodepoort", city: "Johannesburg", lng: 27.8725, lat: -26.1625 },
  { name: "Soweto", city: "Johannesburg", lng: 27.8546, lat: -26.2678 },
  { name: "Midrand", city: "Midrand", lng: 28.1263, lat: -25.9992 },
  { name: "Pretoria CBD", city: "Pretoria", lng: 28.1881, lat: -25.7479 },
  { name: "Centurion", city: "Centurion", lng: 28.1878, lat: -25.8603 },
  { name: "Kempton Park", city: "Kempton Park", lng: 28.2294, lat: -26.1 },
  { name: "Benoni", city: "Benoni", lng: 28.3208, lat: -26.1885 },
  { name: "Boksburg", city: "Boksburg", lng: 28.2294, lat: -26.2125 },
  { name: "Germiston", city: "Germiston", lng: 28.159, lat: -26.2178 },
  { name: "Vereeniging", city: "Vereeniging", lng: 27.9319, lat: -26.6731 },
  { name: "Krugersdorp", city: "Krugersdorp", lng: 27.7749, lat: -26.0855 },
  { name: "Alberton", city: "Alberton", lng: 28.122, lat: -26.2672 },
  { name: "Tembisa", city: "Tembisa", lng: 28.2265, lat: -25.9964 },
] as const;

export function findPharmacyArea(name: string): PharmacyArea | undefined {
  return PHARMACY_AREAS.find((area) => area.name === name);
}
