// The buyer's approximate area on a first visit, from the location headers the edge (CDN) adds
// to each request: no browser prompt, nothing stored. john chose this on 7 Nov 2026 (IP guess,
// no prompt). The header names are configuration, because they depend on the CDN in front of the
// site (Cloudflare `cf-ipcity` / `cf-postal-code` / `cf-ipcountry` with visitor location headers
// on, CloudFront `cloudfront-viewer-city` / `-postal-code` / `-country`). A guess counts only
// when its country is the one the host's Market searches. Shown as "Near <suburb>" until the
// buyer confirms a place in the Deliver to modal; never written to the cookie.

import { deliverToOf, deliverToValue, type DeliverTo } from './deliver-to.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface GeoGuessConfig {
  /** Lower-case name of the header with the visitor's city (or suburb). */
  readonly cityHeader: string;
  /** Lower-case name of the header with the visitor's postcode. */
  readonly postcodeHeader: string;
  /** Lower-case name of the header with the visitor's ISO 3166-1 alpha-2 country. */
  readonly countryHeader: string;
}

const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const NAMES = [
  'EDGE_GEO_CITY_HEADER',
  'EDGE_GEO_POSTCODE_HEADER',
  'EDGE_GEO_COUNTRY_HEADER',
] as const;

/**
 * EDGE_GEO_CITY_HEADER, EDGE_GEO_POSTCODE_HEADER and EDGE_GEO_COUNTRY_HEADER. All empty: null (no
 * guess). Some without the others, a malformed name, or a guess without an edge in front
 * (CLIENT_ADDRESS_SOURCE other than edge, where only the visitor could set these headers) throws,
 * so start-up fails. A visitor who reaches the origin directly and sends them changes only the
 * label they see.
 */
export function parseGeoGuessConfig(env: Env): GeoGuessConfig | null {
  const [city, postcode, country] = NAMES.map((name) => env[name]?.trim().toLowerCase() ?? '');
  const given = [city, postcode, country].filter((name) => name !== '');
  if (given.length === 0) return null;
  if (given.length < NAMES.length) throw new Error(`${NAMES.join(', ')} must be set together`);
  for (const name of given) {
    if (!HEADER.test(name!)) throw new Error(`EDGE_GEO_*_HEADER: '${name}' is not a header name`);
  }
  if (env['CLIENT_ADDRESS_SOURCE']?.trim() !== 'edge') {
    throw new Error('EDGE_GEO_*_HEADER needs CLIENT_ADDRESS_SOURCE=edge: only an edge sets them');
  }
  return { cityHeader: city!, postcodeHeader: postcode!, countryHeader: country! };
}

/**
 * The area the edge headers name, checked by the same rules as the delivery cookie, or null when
 * the guess is off, the headers are missing or not plausible, or the visitor is not in `country`
 * (the host Market's country, lower case; null guesses nothing). Some edges percent-encode
 * non-ASCII city names; those are decoded.
 */
export function geoGuessOf(
  config: GeoGuessConfig | null,
  incoming: { get(name: string): string | null },
  country: string | null,
): DeliverTo | null {
  if (config === null || country === null) return null;
  if (incoming.get(config.countryHeader)?.trim().toLowerCase() !== country) return null;
  const decode = (raw: string | null) => {
    const value = raw?.trim() ?? '';
    try {
      return decodeURIComponent(value);
    } catch {
      return '';
    }
  };
  const suburb = decode(incoming.get(config.cityHeader));
  const postcode = decode(incoming.get(config.postcodeHeader));
  if (suburb === '' || postcode === '') return null;
  return deliverToOf(deliverToValue({ suburb, postcode }));
}

let cached: { readonly config: GeoGuessConfig | null } | undefined;

/** This process's guess configuration, read once; throws when it is malformed. */
export function geoGuessConfig(): GeoGuessConfig | null {
  cached ??= { config: parseGeoGuessConfig(process.env) };
  return cached.config;
}
