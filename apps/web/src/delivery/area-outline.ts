// The outline of the areas the Market delivers to (ServiceArea, FE-098): the parser of the API's
// answer and of the buyer site's own /api/deliver-to/area, shared by the server route and the
// modal. Both sides check the shape, so a malformed or oversized answer draws nothing.
import type { AreaOutline, AreaShape, GeoPoint, MapBounds } from '../storefront/types.ts';

/** More points than any real outline needs (the API allows 20 000); a bigger answer is refused. */
export const MAX_OUTLINE_POINTS = 20_000;
const MAX_AREAS = 50;
const AREA_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const NAME_LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function pointOf(value: unknown): GeoPoint | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [lng, lat] = value as unknown[];
  if (!isNumber(lng) || !isNumber(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90)
    return undefined;
  return { lat, lng };
}

/** [lng, lat] rings (GeoJSON order) as points, or undefined for anything else. */
function shapeOf(value: unknown, budget: { points: number }): AreaShape | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const polygons: GeoPoint[][][] = [];
  for (const polygon of value as unknown[]) {
    if (!Array.isArray(polygon) || polygon.length === 0) return undefined;
    const rings: GeoPoint[][] = [];
    for (const ring of polygon as unknown[]) {
      if (!Array.isArray(ring) || ring.length < 4) return undefined;
      budget.points -= ring.length;
      if (budget.points < 0) return undefined;
      const points: GeoPoint[] = [];
      for (const raw of ring as unknown[]) {
        const point = pointOf(raw);
        if (point === undefined) return undefined;
        points.push(point);
      }
      rings.push(points);
    }
    polygons.push(rings);
  }
  return polygons;
}

function namesOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const names: Record<string, string> = {};
  for (const [locale, name] of Object.entries(value)) {
    if (!NAME_LOCALE.test(locale) || typeof name !== 'string' || name.length > 120) continue;
    names[locale] = name;
  }
  return typeof names['en'] === 'string' ? names : undefined;
}

function boundsOf(value: unknown): MapBounds | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const { north, south, west, east } = value as Record<string, unknown>;
  if (![north, south, west, east].every(isNumber)) return undefined;
  const box = { north, south, west, east } as MapBounds;
  return box.north > box.south && box.east > box.west ? box : undefined;
}

/** The areas and box of an answer (both answers share them), or undefined when malformed. */
function areasOf(body: unknown): Omit<AreaOutline, 'credit'> | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { areas, bounds } = body as Record<string, unknown>;
  if (!Array.isArray(areas) || areas.length > MAX_AREAS) return undefined;
  const budget = { points: MAX_OUTLINE_POINTS };
  const parsed: AreaOutline['areas'][number][] = [];
  for (const area of areas as unknown[]) {
    if (typeof area !== 'object' || area === null) return undefined;
    const { code, names, boundary } = area as Record<string, unknown>;
    const named = namesOf(names);
    if (typeof code !== 'string' || !AREA_CODE.test(code) || named === undefined) return undefined;
    if (typeof boundary !== 'object' || boundary === null) return undefined;
    const { type, coordinates } = boundary as Record<string, unknown>;
    const shape = type === 'MultiPolygon' ? shapeOf(coordinates, budget) : undefined;
    if (shape === undefined) return undefined;
    parsed.push({ code, names: named, shape });
  }
  const box = boundsOf(bounds);
  return box === undefined ? undefined : { areas: parsed, bounds: box };
}

const creditLine = (line: unknown): string | null =>
  typeof line === 'string' && line.length > 0 && line.length <= 200 ? line : null;

/**
 * The API's `GET shipping/delivery-area-map` answer as an outline, or undefined when it is not
 * the expected shape. The credit line is built from the source's attribution and licence.
 */
export function outlineFromApi(body: unknown): AreaOutline | undefined {
  const parsed = areasOf(body);
  if (parsed === undefined) return undefined;
  const source = (body as { source?: unknown }).source;
  const { attribution, licence } =
    typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {};
  const credit =
    typeof attribution === 'string' && typeof licence === 'string'
      ? creditLine(`${attribution}, ${licence}`)
      : null;
  return { ...parsed, credit };
}

/** The outline as the buyer site's route sends it: points back in GeoJSON [lng, lat] order. */
export function outlineToWire(outline: AreaOutline): unknown {
  return {
    areas: outline.areas.map(({ code, names, shape }) => ({
      code,
      names,
      boundary: {
        type: 'MultiPolygon',
        coordinates: shape.map((polygon) =>
          polygon.map((ring) => ring.map(({ lng, lat }) => [lng, lat])),
        ),
      },
    })),
    bounds: outline.bounds,
    credit: outline.credit,
  };
}

/** The route's answer read back in the browser, or undefined when it is not the expected shape. */
export function outlineFromWire(body: unknown): AreaOutline | undefined {
  const parsed = areasOf(body);
  if (parsed === undefined) return undefined;
  return { ...parsed, credit: creditLine((body as { credit?: unknown }).credit) };
}

/** Every area's polygons as one shape, for the map and the preview. */
export function joinedShape(outline: AreaOutline): AreaShape {
  return outline.areas.flatMap((area) => area.shape);
}

let pending: Promise<AreaOutline | null> | undefined;

/**
 * The browser's read of /api/deliver-to/area, once per page: every later open reuses it. A failed
 * or malformed answer is not kept, so the next open tries again; until then no outline is drawn
 * (the postcode check still answers).
 */
export function fetchAreaOutline(read: typeof fetch = fetch): Promise<AreaOutline | null> {
  const current =
    pending ??
    read('/api/deliver-to/area', { headers: { accept: 'application/json' } })
      .then(async (response) =>
        response.ok ? (outlineFromWire(await response.json()) ?? null) : null,
      )
      .catch(() => null);
  pending = current;
  void current.then((outline) => {
    if (outline === null && pending === current) pending = undefined;
  });
  return current;
}

/** Forgets the kept read (tests). */
export function forgetAreaOutline(): void {
  pending = undefined;
}

/** A box a little larger than the outline, so the drawn map shows its edge. */
export function paddedBounds(bounds: MapBounds): MapBounds {
  const dy = (bounds.north - bounds.south) * 0.05;
  const dx = (bounds.east - bounds.west) * 0.05;
  return {
    north: bounds.north + dy,
    south: bounds.south - dy,
    west: bounds.west - dx,
    east: bounds.east + dx,
  };
}
