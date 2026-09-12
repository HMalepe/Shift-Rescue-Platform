/**
 * Area names offered on the manager registration form.
 *
 * Must match `packages/core/src/pharmacy-areas.ts`'s `PHARMACY_AREAS` names
 * exactly — the API resolves the submitted name to coordinates server-side
 * (see that module for why this app picks an area rather than typing a
 * coordinate pair). Duplicated here rather than imported: this app is
 * deliberately a thin client of the API over HTTP (see the header comment in
 * `lib/api.ts`) and does not depend on `@locum/core` for anything else, so
 * pulling in the whole package for one string array would be the wrong
 * trade.
 */
export const PHARMACY_AREA_NAMES = [
  "Johannesburg CBD",
  "Sandton",
  "Randburg",
  "Roodepoort",
  "Soweto",
  "Midrand",
  "Pretoria CBD",
  "Centurion",
  "Kempton Park",
  "Benoni",
  "Boksburg",
  "Germiston",
  "Vereeniging",
  "Krugersdorp",
  "Alberton",
  "Tembisa",
] as const;
