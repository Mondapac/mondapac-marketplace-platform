import type { GeoPoint, MapBounds, Place } from '../storefront/types.ts';

/** "Kedron QLD 4031": the suburb line of a place. */
export function locality(place: Place): string {
  return `${place.suburb} ${place.region} ${place.postcode}`;
}

/** The whole address on one line: "12 Example Street, Kedron QLD 4031". */
export function addressLine(place: Place): string {
  return place.street ? `${place.street}, ${locality(place)}` : locality(place);
}

/**
 * Whether a point lies inside an area's boundary (ray casting). A preview for the modal only:
 * the order still checks the address against the service area on the server.
 */
export function insideArea(point: GeoPoint, boundary: readonly GeoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const a = boundary[i]!;
    const b = boundary[j]!;
    if (
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng
    )
      inside = !inside;
  }
  return inside;
}

/** The side of the stubbed map's square plane, in plane units. */
export const PLANE = 400;

/** A point on the stubbed map's plane (0 to PLANE on both axes, north up). */
export interface PlanePoint {
  readonly x: number;
  readonly y: number;
}

export function toPlane(point: GeoPoint, bounds: MapBounds): PlanePoint {
  return {
    x: ((point.lng - bounds.west) / (bounds.east - bounds.west)) * PLANE,
    y: ((bounds.north - point.lat) / (bounds.north - bounds.south)) * PLANE,
  };
}

export function fromPlane({ x, y }: PlanePoint, bounds: MapBounds): GeoPoint {
  return {
    lat: bounds.north - (y / PLANE) * (bounds.north - bounds.south),
    lng: bounds.west + (x / PLANE) * (bounds.east - bounds.west),
  };
}

export function clampToPlane({ x, y }: PlanePoint): PlanePoint {
  return { x: Math.min(PLANE, Math.max(0, x)), y: Math.min(PLANE, Math.max(0, y)) };
}
