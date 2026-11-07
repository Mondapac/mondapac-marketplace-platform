// Mapbox Geocoding (v6) for the Deliver to modal's address lookup: configuration, the request
// URLs and the mapping of an answer to `Place`. Pure functions, no `server-only` import, so tests
// run them directly; the token is only ever used on the server (places-server.ts). john chose
// Mapbox on 20 Oct 2026 (design/storefront-prototypes/map-address-options-fa.md).

import type { GeoPoint, Place } from '../storefront/types.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface MapboxConfig {
  /** The search token; server-side only, never sent to the browser. */
  readonly token: string;
  /** Market code -> ISO 3166-1 alpha-2 country code (lower case) searched for that Market. */
  readonly countries: ReadonlyMap<string, string>;
}

const MARKET_ID = /^[A-Z]{2}$/u;
const COUNTRY = /^[a-z]{2}$/u;
const TOKEN = /^[A-Za-z0-9._-]{20,400}$/u;

/**
 * MAPBOX_SEARCH_TOKEN and MAPBOX_COUNTRIES (`MARKET=country` pairs, for example `AU=au`). Both
 * empty: null, and the modal keeps its sample lookup. One without the other, or anything
 * malformed, throws, so start-up fails rather than searching the wrong country.
 */
export function parseMapboxConfig(env: Env): MapboxConfig | null {
  const token = env['MAPBOX_SEARCH_TOKEN']?.trim() ?? '';
  const raw = env['MAPBOX_COUNTRIES']?.trim() ?? '';
  if (token === '' && raw === '') return null;
  if (token === '' || raw === '') {
    throw new Error('MAPBOX_SEARCH_TOKEN and MAPBOX_COUNTRIES must be set together');
  }
  if (!TOKEN.test(token)) throw new Error('MAPBOX_SEARCH_TOKEN is not a Mapbox token');
  const countries = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const [market, country, ...rest] = entry.split('=').map((part) => part.trim());
    if (rest.length > 0 || !market || !country) {
      throw new Error(`MAPBOX_COUNTRIES: '${entry.trim()}' is not MARKET=country`);
    }
    if (!MARKET_ID.test(market))
      throw new Error(`MAPBOX_COUNTRIES: '${market}' is not a Market code`);
    const lower = country.toLowerCase();
    if (!COUNTRY.test(lower))
      throw new Error(`MAPBOX_COUNTRIES: '${country}' is not a country code`);
    if (countries.has(market)) throw new Error(`MAPBOX_COUNTRIES: '${market}' is listed twice`);
    countries.set(market, lower);
  }
  return { token, countries };
}

const BASE = 'https://api.mapbox.com/search/geocode/v6';

/** Most suggestions asked for (the modal lists up to six). */
export const MAX_SUGGESTIONS = 6;
/** Fewest characters typed before Mapbox is asked. */
export const MIN_QUERY = 3;
/** Longest text passed on. */
export const MAX_QUERY = 120;

/** Forward geocoding while the buyer types: street addresses in the Market's country. */
export function forwardUrl(token: string, country: string, query: string): string {
  const params = new URLSearchParams({
    q: query,
    country,
    types: 'address',
    autocomplete: 'true',
    limit: String(MAX_SUGGESTIONS),
    access_token: token,
  });
  return `${BASE}/forward?${params}`;
}

/** Reverse geocoding of a pin or the device location: the nearest street address. */
export function reverseUrl(token: string, country: string, point: GeoPoint): string {
  const params = new URLSearchParams({
    longitude: point.lng.toFixed(6),
    latitude: point.lat.toFixed(6),
    country,
    types: 'address',
    limit: '1',
    access_token: token,
  });
  return `${BASE}/reverse?${params}`;
}

interface Named {
  readonly name?: unknown;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * One Mapbox feature as a `Place`, or null when it lacks a suburb, a postcode or a position: the
 * header label and the delivery-area check need the suburb and the postcode. A Market whose
 * addresses carry no postcode therefore gets no results: onboarding such a Market needs another
 * area key first.
 */
export function placeOfFeature(feature: unknown): Place | null {
  if (typeof feature !== 'object' || feature === null) return null;
  const properties = (feature as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null) return null;
  const p = properties as {
    mapbox_id?: unknown;
    name?: unknown;
    coordinates?: { longitude?: unknown; latitude?: unknown };
    context?: {
      locality?: Named;
      place?: Named;
      postcode?: Named;
      region?: Named & { region_code?: unknown };
    };
  };
  const lng = p.coordinates?.longitude;
  const lat = p.coordinates?.latitude;
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const context = p.context ?? {};
  const suburb = text(context.locality?.name) || text(context.place?.name);
  const postcode = text(context.postcode?.name);
  const region = text(context.region?.region_code) || text(context.region?.name);
  const id = text(p.mapbox_id);
  if (suburb === '' || postcode === '' || id === '') return null;
  return { id, street: text(p.name), suburb, region, postcode, point: { lat, lng } };
}

/** The places of a Mapbox answer, in its order, without duplicates or incomplete features. */
export function placesOf(body: unknown): readonly Place[] {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const feature of features) {
    const place = placeOfFeature(feature);
    if (place && !seen.has(place.id)) {
      seen.add(place.id);
      places.push(place);
    }
  }
  return places.slice(0, MAX_SUGGESTIONS);
}

/** A pin or device point, when both numbers are real coordinates. */
export function pointOf(lat: string | null, lng: string | null): GeoPoint | null {
  if (lat === null || lng === null || lat.trim() === '' || lng.trim() === '') return null;
  const point = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  if (Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return null;
  return point;
}
