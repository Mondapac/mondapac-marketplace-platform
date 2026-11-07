// The server side of the Deliver to lookup: the buyer site's own routes under /api/deliver-to/
// answer the modal's address search and reverse lookup (the delivery-area check is checkout's
// server action `deliveryAreaFor`). Mapbox is called from here so the token never reaches the
// browser. Sec-Fetch-Site / Referer keep other sites' pages from using it in a browser (a script
// can forge those headers: the per-client and per-process limits are the guard against that).
import 'server-only';
import type { GeoPoint } from '../storefront/types.ts';
import { storefrontApiConfig } from '../storefront/config.ts';
import { hostFor, parseStorefrontHosts, type StorefrontHost } from '../storefront/hosts.ts';
import {
  MAX_QUERY,
  MIN_QUERY,
  forwardUrl,
  parseMapboxConfig,
  placesOf,
  pointOf,
  reverseUrl,
  type MapboxConfig,
} from './mapbox.ts';
import { clientKey, fixedWindowLimiter, type RateLimiter } from './rate-limit.ts';

interface Incoming {
  get(name: string): string | null;
}

export interface PlacesDeps {
  readonly config: MapboxConfig | null;
  readonly hosts: readonly StorefrontHost[];
  /**
   * Whether the API is configured: the live lookup needs its delivery-area answer, since the
   * sample boundary only fits sample places.
   */
  readonly apiOn: boolean;
  readonly limiter: RateLimiter;
  readonly fetch: typeof fetch;
}

/** Requests per client address per minute, search and reverse together. */
export const REQUESTS_PER_MINUTE = 60;
/** Requests per process per minute, all clients together: the cost ceiling of one instance. */
export const PROCESS_REQUESTS_PER_MINUTE = 1200;
const TIMEOUT_MS = 4000;
const HEADERS = { 'cache-control': 'no-store' } as const;

function log(fields: Record<string, unknown>) {
  console.warn(JSON.stringify(fields));
}

/** The Mapbox country of the Market this request came to, or null when the lookup is off. */
export function countryFor(deps: PlacesDeps, incoming: Incoming): string | null {
  return hostAndCountry(deps, incoming)?.country ?? null;
}

function hostAndCountry(
  deps: PlacesDeps,
  incoming: Incoming,
): { readonly host: StorefrontHost; readonly country: string } | null {
  if (deps.config === null || !deps.apiOn) return null;
  const host = hostFor(deps.hosts, incoming.get('host'));
  const country = host ? deps.config.countries.get(host.marketId) : undefined;
  return host && country ? { host, country } : null;
}

/**
 * Whether the request came from this site's own page: the browser's `Sec-Fetch-Site`, or else a
 * `Referer` on this host's origin. This stops cross-site use in browsers only; a script can send
 * either header, so the rate limits are what bound direct calls.
 */
export function fromOwnPage(incoming: Incoming, host: StorefrontHost): boolean {
  const site = incoming.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';
  const referer = incoming.get('referer');
  if (referer === null) return false;
  try {
    return new URL(referer).origin === host.origin;
  } catch {
    return false;
  }
}

/** The checks every lookup route runs first: on, own page, under the limits. */
function admit(
  deps: PlacesDeps,
  incoming: Incoming,
): { readonly country: string } | { readonly refused: Response } {
  const found = hostAndCountry(deps, incoming);
  if (found === null) return { refused: json({ code: 'places.disabled' }, 404) };
  if (!fromOwnPage(incoming, found.host))
    return { refused: json({ code: 'request.forbidden' }, 403) };
  return { country: found.country };
}

function throttled(deps: PlacesDeps, incoming: Incoming): Response | null {
  if (deps.limiter.take(clientKey(clientOf(incoming)))) return null;
  return json({ code: 'request.throttled' }, 429, { 'retry-after': '60' });
}

/** Whether the live lookup serves this request; false keeps the modal on sample places. */
export function lookupIsLive(deps: PlacesDeps, incoming: Incoming): boolean {
  return countryFor(deps, incoming) !== null;
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...HEADERS, ...extra } });

/** The client address server.mjs set (browser-sent copies are removed there). */
function clientOf(incoming: Incoming): string {
  return incoming.get('x-mp-client-address') || 'unknown';
}

async function askMapbox(
  deps: PlacesDeps,
  url: string,
  route: string,
): Promise<{ readonly body: unknown } | null> {
  try {
    const response = await deps.fetch(url, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      // The URL carries the token: log the route and status only.
      log({ msg: 'storefront.places-refused', route, status: response.status });
      return null;
    }
    return { body: (await response.json()) as unknown };
  } catch (error) {
    log({
      msg: 'storefront.places-failed',
      route,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/** GET /api/deliver-to/search?q=: street addresses matching what the buyer typed. */
export async function answerSearch(deps: PlacesDeps, incoming: Incoming, url: URL) {
  const admitted = admit(deps, incoming);
  if ('refused' in admitted) return admitted.refused;
  const { country } = admitted;
  const query = (url.searchParams.get('q') ?? '').replace(/\s+/gu, ' ').trim();
  if (query.length > MAX_QUERY) return json({ code: 'validation.failed' }, 400);
  if (query.length < MIN_QUERY) return json({ places: [] });
  const limited = throttled(deps, incoming);
  if (limited) return limited;
  const answer = await askMapbox(deps, forwardUrl(deps.config!.token, country, query), 'search');
  if (answer === null) return json({ code: 'places.unavailable' }, 503);
  return json({ places: placesOf(answer.body) });
}

/** GET /api/deliver-to/suburb?lat=&lng=: the suburb at a pin or the device location. */
export async function answerSuburb(deps: PlacesDeps, incoming: Incoming, url: URL) {
  const admitted = admit(deps, incoming);
  if ('refused' in admitted) return admitted.refused;
  const { country } = admitted;
  const point: GeoPoint | null = pointOf(url.searchParams.get('lat'), url.searchParams.get('lng'));
  if (point === null) return json({ code: 'validation.failed' }, 400);
  const limited = throttled(deps, incoming);
  if (limited) return limited;
  const answer = await askMapbox(deps, reverseUrl(deps.config!.token, country, point), 'suburb');
  if (answer === null) return json({ code: 'places.unavailable' }, 503);
  const place = placesOf(answer.body)[0];
  // Only the suburb is answered, under an id of its own: no street address or address id.
  return json({
    place: place ? { ...place, id: `${place.postcode}:${place.suburb}`, street: '', point } : null,
  });
}

let deps: PlacesDeps | undefined;

/**
 * The lookup's dependencies from the environment. Throws when MAPBOX_* is malformed, or set
 * without STOREFRONT_HOSTS (the Market of each host picks the country searched).
 */
export function placesDepsOf(
  env: Readonly<Record<string, string | undefined>>,
  apiOn: boolean,
): PlacesDeps {
  const config = parseMapboxConfig(env);
  let hosts: readonly StorefrontHost[] = [];
  if (config !== null) {
    if ((env['STOREFRONT_HOSTS']?.trim() ?? '') === '') {
      throw new Error(
        "STOREFRONT_HOSTS is required with MAPBOX_SEARCH_TOKEN: each host's Market picks the " +
          'country searched (MAPBOX_COUNTRIES)',
      );
    }
    hosts = parseStorefrontHosts(env['STOREFRONT_HOSTS']);
  }
  return {
    config,
    hosts,
    apiOn,
    limiter: fixedWindowLimiter(REQUESTS_PER_MINUTE, 60_000, {
      total: PROCESS_REQUESTS_PER_MINUTE,
      // Once per minute at most: an alert rule can watch this message.
      onTotalSpent: () => log({ msg: 'storefront.places-process-limit' }),
    }),
    fetch: (input, init) => fetch(input, init),
  };
}

/**
 * This process's dependencies, read once. instrumentation.ts calls it at start-up, so a malformed
 * configuration stops the server before any page is served.
 */
export function placesDeps(): PlacesDeps {
  deps ??= placesDepsOf(process.env, storefrontApiConfig() !== null);
  return deps;
}
