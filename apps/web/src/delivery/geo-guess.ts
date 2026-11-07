// The buyer's approximate area on a first visit, from the location headers the edge (CDN) adds
// to each request: no browser prompt, nothing stored. john chose this on 7 Nov 2026 (IP guess,
// no prompt). The header names are configuration, because they depend on the CDN in front of the
// site (Cloudflare `cf-ipcity` / `cf-postal-code` with visitor location headers on, CloudFront
// `cloudfront-viewer-city` / `cloudfront-viewer-postal-code`). Shown as "Near <city> <postcode>"
// until the buyer confirms a place in the Deliver to modal; never written to the cookie.

import { deliverToOf, deliverToValue, type DeliverTo } from './deliver-to.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface GeoGuessConfig {
  /** Lower-case name of the header with the visitor's city (or suburb). */
  readonly cityHeader: string;
  /** Lower-case name of the header with the visitor's postcode. */
  readonly postcodeHeader: string;
}

const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * EDGE_GEO_CITY_HEADER and EDGE_GEO_POSTCODE_HEADER. Both empty: null (no guess). One without
 * the other, or a malformed name, throws so start-up fails. Only meaningful behind an edge that
 * sets these headers itself (CLIENT_ADDRESS_SOURCE=edge); a visitor who sends them changes only
 * the label they see.
 */
export function parseGeoGuessConfig(env: Env): GeoGuessConfig | null {
  const city = env['EDGE_GEO_CITY_HEADER']?.trim().toLowerCase() ?? '';
  const postcode = env['EDGE_GEO_POSTCODE_HEADER']?.trim().toLowerCase() ?? '';
  if (city === '' && postcode === '') return null;
  if (city === '' || postcode === '') {
    throw new Error('EDGE_GEO_CITY_HEADER and EDGE_GEO_POSTCODE_HEADER must be set together');
  }
  for (const name of [city, postcode]) {
    if (!HEADER.test(name)) throw new Error(`EDGE_GEO_*_HEADER: '${name}' is not a header name`);
  }
  return { cityHeader: city, postcodeHeader: postcode };
}

/**
 * The area the edge headers name, checked by the same rules as the delivery cookie, or null when
 * the guess is off or the headers are missing or not plausible. Some edges percent-encode
 * non-ASCII city names; those are decoded.
 */
export function geoGuessOf(
  config: GeoGuessConfig | null,
  incoming: { get(name: string): string | null },
): DeliverTo | null {
  if (config === null) return null;
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
