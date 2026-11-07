// The server side of the Deliver to lookup: the buyer site's own routes under /api/deliver-to/
// answer the modal's address search and reverse lookup (the delivery-area check is checkout's
// server action `deliveryAreaFor`). Mapbox is called from here
// so the token never reaches the browser and each client address is rate limited.
import 'server-only';
import type { GeoPoint } from '../storefront/types.ts';
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
import { fixedWindowLimiter, type RateLimiter } from './rate-limit.ts';

interface Incoming {
  get(name: string): string | null;
}

export interface PlacesDeps {
  readonly config: MapboxConfig | null;
  readonly hosts: readonly StorefrontHost[];
  readonly limiter: RateLimiter;
  readonly fetch: typeof fetch;
}

/** Requests per client address per minute, search and reverse together. */
export const REQUESTS_PER_MINUTE = 60;
const TIMEOUT_MS = 4000;
const HEADERS = { 'cache-control': 'no-store' } as const;

function log(fields: Record<string, unknown>) {
  console.warn(JSON.stringify(fields));
}

/** The Mapbox country of the Market this request came to, or null when the lookup is off. */
export function countryFor(deps: PlacesDeps, incoming: Incoming): string | null {
  if (deps.config === null) return null;
  const host = hostFor(deps.hosts, incoming.get('host'));
  return host ? (deps.config.countries.get(host.marketId) ?? null) : null;
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
  const country = countryFor(deps, incoming);
  if (country === null) return json({ code: 'places.disabled' }, 404);
  const query = (url.searchParams.get('q') ?? '').replace(/\s+/gu, ' ').trim();
  if (query.length > MAX_QUERY) return json({ code: 'validation.failed' }, 400);
  if (query.length < MIN_QUERY) return json({ places: [] });
  if (!deps.limiter.take(clientOf(incoming))) {
    return json({ code: 'request.throttled' }, 429, { 'retry-after': '60' });
  }
  const answer = await askMapbox(deps, forwardUrl(deps.config!.token, country, query), 'search');
  if (answer === null) return json({ code: 'places.unavailable' }, 503);
  return json({ places: placesOf(answer.body) });
}

/** GET /api/deliver-to/suburb?lat=&lng=: the suburb at a pin or the device location. */
export async function answerSuburb(deps: PlacesDeps, incoming: Incoming, url: URL) {
  const country = countryFor(deps, incoming);
  if (country === null) return json({ code: 'places.disabled' }, 404);
  const point: GeoPoint | null = pointOf(url.searchParams.get('lat'), url.searchParams.get('lng'));
  if (point === null) return json({ code: 'validation.failed' }, 400);
  if (!deps.limiter.take(clientOf(incoming))) {
    return json({ code: 'request.throttled' }, 429, { 'retry-after': '60' });
  }
  const answer = await askMapbox(deps, reverseUrl(deps.config!.token, country, point), 'suburb');
  if (answer === null) return json({ code: 'places.unavailable' }, 503);
  const place = placesOf(answer.body)[0];
  // Only the suburb is answered: the modal shows "Near <suburb>" and keeps no street address.
  return json({ place: place ? { ...place, street: '', point } : null });
}

let deps: PlacesDeps | undefined;

/** This process's dependencies, read once; throws when the configuration is malformed. */
export function placesDeps(): PlacesDeps {
  if (deps === undefined) {
    const config = parseMapboxConfig(process.env);
    let hosts: readonly StorefrontHost[] = [];
    if (config !== null) hosts = parseStorefrontHosts(process.env['STOREFRONT_HOSTS']);
    deps = {
      config,
      hosts,
      limiter: fixedWindowLimiter(REQUESTS_PER_MINUTE, 60_000),
      fetch: (input, init) => fetch(input, init),
    };
  }
  return deps;
}
