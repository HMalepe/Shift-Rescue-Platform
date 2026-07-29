import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  assertValidLngLat,
  createDatabase,
  parseEwkbPoint,
  type LngLat,
} from "../src/index";

/**
 * GATE: schema.geography_roundtrip
 *
 * The EWKB parser in src/types/geography.ts decodes what PostGIS actually
 * returns. A parser that is subtly wrong — byte order, SRID header offset,
 * lng/lat transposition — produces coordinates that are plausible rather than
 * absent, so nothing crashes and every proximity result is quietly wrong.
 *
 * Transposing lng/lat is the specific disaster this guards: Johannesburg at
 * (-26.2, 28.0) instead of (28.0, -26.2) lands in Somalia. Every ST_DWithin
 * still returns rows, just the wrong ones.
 *
 * These assertions therefore compare against PostGIS itself rather than
 * against hand-written expected bytes, which would only re-encode whatever
 * mistake the parser already makes.
 */

const url =
  process.env["DATABASE_URL"] ??
  "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev";

const { db, client } = createDatabase({ url });

afterAll(async () => {
  await client.end();
});

async function roundTrip(point: LngLat): Promise<LngLat> {
  const rows = await db.execute<{ ewkb: string }>(
    sql`SELECT ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography::text AS ewkb`,
  );
  const ewkb = (rows as unknown as { ewkb: string }[])[0]!.ewkb;
  return parseEwkbPoint(ewkb);
}

describe("GATE schema.geography_roundtrip", () => {
  const cases: ReadonlyArray<readonly [string, LngLat]> = [
    ["Johannesburg CBD", { lng: 28.0473, lat: -26.2041 }],
    ["Sandton", { lng: 28.0567, lat: -26.1076 }],
    ["Pretoria", { lng: 28.1881, lat: -25.7479 }],
    // Sign coverage: Gauteng is all (+lng, -lat), so a parser that mixed up
    // sign handling would pass on ZA data alone.
    ["northern hemisphere, negative lng", { lng: -74.006, lat: 40.7128 }],
    ["origin", { lng: 0, lat: 0 }],
  ];

  for (const [name, point] of cases) {
    it(`round-trips ${name} through PostGIS`, async () => {
      const parsed = await roundTrip(point);
      expect(parsed.lng).toBeCloseTo(point.lng, 9);
      expect(parsed.lat).toBeCloseTo(point.lat, 9);
    });
  }

  it("agrees with ST_X / ST_Y rather than only with itself", async () => {
    const point = { lng: 28.0473, lat: -26.2041 };
    const rows = await db.execute<{ ewkb: string; x: number; y: number }>(
      sql`
        SELECT
          g::text AS ewkb,
          ST_X(g::geometry) AS x,
          ST_Y(g::geometry) AS y
        FROM (
          SELECT ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography AS g
        ) t
      `,
    );
    const row = (rows as unknown as { ewkb: string; x: number; y: number }[])[0]!;
    const parsed = parseEwkbPoint(row.ewkb);

    // PostGIS's own X is longitude and Y is latitude. If the parser has these
    // swapped, this fails even though the round-trip above would still pass.
    expect(parsed.lng).toBeCloseTo(row.x, 9);
    expect(parsed.lat).toBeCloseTo(row.y, 9);
  });

  it("rejects malformed input instead of returning a plausible point", () => {
    expect(() => parseEwkbPoint("00")).toThrow(/too short/i);
    // A LineString EWKB header must not be silently read as a point.
    expect(() => parseEwkbPoint("0102000020E6100000" + "0".repeat(40))).toThrow(
      /Point/i,
    );
  });

  it("refuses an out-of-range or non-finite coordinate", () => {
    // Guarding at the boundary matters because PostGIS does NOT reject these:
    // a longitude of 200 wraps to -160 and produces a perfectly queryable row
    // in the wrong hemisphere.
    expect(() => assertValidLngLat({ lng: 200, lat: 0 })).toThrow(/longitude/i);
    expect(() => assertValidLngLat({ lng: -181, lat: 0 })).toThrow(/longitude/i);
    expect(() => assertValidLngLat({ lng: 0, lat: 99 })).toThrow(/latitude/i);
    expect(() => assertValidLngLat({ lng: Number.NaN, lat: 0 })).toThrow(/finite/i);
    expect(() => assertValidLngLat({ lng: 0, lat: Number.POSITIVE_INFINITY })).toThrow(/finite/i);

    // Gauteng and the exact boundaries stay valid.
    expect(() => assertValidLngLat({ lng: 28.0473, lat: -26.2041 })).not.toThrow();
    expect(() => assertValidLngLat({ lng: 180, lat: -90 })).not.toThrow();
  });

  it("confirms PostGIS itself would have accepted the out-of-range value", async () => {
    // Justifies the guard above: this is the row we would otherwise have
    // stored. PostGIS normalises 200 rather than raising.
    const rows = await db.execute<{ x: number }>(
      sql`SELECT ST_X(ST_SetSRID(ST_MakePoint(200, 0), 4326)::geography::geometry) AS x`,
    );
    const x = (rows as unknown as { x: number }[])[0]!.x;
    expect(x).not.toBe(200);
  });
});
