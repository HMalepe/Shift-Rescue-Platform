import { customType } from "drizzle-orm/pg-core";

/**
 * A WGS-84 coordinate. Longitude first, matching PostGIS `POINT(x y)` ordering.
 *
 * The lng/lat naming is deliberate: `POINT(lat lng)` is the single most common
 * PostGIS bug, and it fails silently — Johannesburg at (-26.2, 28.0) becomes a
 * point in Somalia rather than an error. Naming the fields makes the ordering
 * impossible to get wrong at a call site.
 */
export interface LngLat {
  readonly lng: number;
  readonly lat: number;
}

const SRID_WGS84 = 4326;

/** Geometry type id for a 2D Point in WKB. */
const WKB_POINT = 1;
/** EWKB flag indicating an SRID is embedded in the header. */
const EWKB_SRID_FLAG = 0x20000000;

/**
 * Parses the EWKB hex string PostGIS returns for a `geography`/`geometry`
 * column when it is selected without an explicit `ST_AsGeoJSON` / `ST_X`
 * projection.
 *
 * Layout (little-endian example):
 *   01              byte order   (00 = big endian, 01 = little endian)
 *   01000020        geometry type, SRID flag set
 *   E6100000        SRID (4326)
 *   ................ 8-byte float64 X (longitude)
 *   ................ 8-byte float64 Y (latitude)
 *
 * Written out rather than pulled from a WKB library because this is the only
 * shape we ever store, and a 40-line parser we control beats a transitive
 * dependency in the hot path of every proximity query.
 */
export function parseEwkbPoint(hex: string): LngLat {
  if (hex.length < 42) {
    throw new Error(`EWKB point too short: got ${hex.length} hex chars`);
  }

  const bytes = Buffer.from(hex, "hex");
  const littleEndian = bytes.readUInt8(0) === 1;

  const readU32 = (offset: number): number =>
    littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const readF64 = (offset: number): number =>
    littleEndian ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset);

  const typeField = readU32(1);
  const hasSrid = (typeField & EWKB_SRID_FLAG) !== 0;
  const geometryType = typeField & 0xff;

  if (geometryType !== WKB_POINT) {
    throw new Error(
      `expected a WKB Point (type ${WKB_POINT}), got type ${geometryType}`,
    );
  }

  // Coordinates start after the byte-order byte, the type field, and the
  // SRID word when present.
  const coordinateOffset = hasSrid ? 9 : 5;

  return {
    lng: readF64(coordinateOffset),
    lat: readF64(coordinateOffset + 8),
  };
}

/**
 * `geography(Point, 4326)` — the storage type for every coordinate in the
 * system.
 *
 * `geography` rather than `geometry` is a deliberate call. Distance matching
 * (§4.4/§12.3) is expressed in kilometres across Gauteng, and `geography`
 * measures in metres on the spheroid, so `ST_DWithin(a, b, 15000)` is honestly
 * 15 km. The `geometry` equivalent measures in degrees, which are not a
 * constant distance apart, and would require reprojecting to a local UTM zone
 * to get a true radius. For a product whose core promise is "within 15 km",
 * paying the small `geography` performance cost to avoid a class of quiet
 * correctness bugs is the right trade.
 */
export const geographyPoint = customType<{
  data: LngLat;
  driverData: string;
}>({
  dataType() {
    return `geography(Point, ${SRID_WGS84})`;
  },

  toDriver(value: LngLat): string {
    if (!Number.isFinite(value.lng) || !Number.isFinite(value.lat)) {
      throw new Error(
        `refusing to store a non-finite coordinate: ${JSON.stringify(value)}`,
      );
    }
    if (value.lng < -180 || value.lng > 180) {
      throw new Error(`longitude out of range: ${value.lng}`);
    }
    if (value.lat < -90 || value.lat > 90) {
      throw new Error(`latitude out of range: ${value.lat}`);
    }
    return `SRID=${SRID_WGS84};POINT(${value.lng} ${value.lat})`;
  },

  fromDriver(value: string): LngLat {
    // Tolerate GeoJSON in case a query projects through ST_AsGeoJSON.
    if (value.startsWith("{")) {
      const parsed = JSON.parse(value) as { coordinates: [number, number] };
      const [lng, lat] = parsed.coordinates;
      return { lng, lat };
    }
    return parseEwkbPoint(value);
  },
});
