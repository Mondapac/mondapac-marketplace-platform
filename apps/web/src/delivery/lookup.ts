import type {
  DeliveryAreaAnswer,
  DeliveryLocatorSource,
  GeoPoint,
  Place,
} from '../storefront/types.ts';
import type { DeliverTo } from './deliver-to.ts';
import { addressLine } from './geo.ts';

/**
 * The address lookup behind the Deliver to modal. `liveLookup` asks the buyer site's own routes
 * (Mapbox, chosen by john 20 Oct 2026) and the API's delivery area; `sampleLookup` answers from
 * sample places when the lookup is not configured (local demo, tests, CI).
 */
export interface AddressLookup {
  /** Addresses matching what the buyer typed, best first. */
  search(query: string): Promise<readonly Place[]>;
  /** The suburb at a point (reverse geocoding), or null when there is none. */
  suburbAt(point: GeoPoint): Promise<Place | null>;
  /** The suburb a buyer chose before (a guest keeps only its name and postcode). */
  locate(area: DeliverTo): Promise<Place | null>;
  /**
   * Whether the Market delivers to a postcode, or null when nobody could say: the modal then
   * previews with the area's boundary, and checkout checks again before it takes an order.
   */
  delivers(postcode: string): Promise<boolean | null>;
}

const MAX_RESULTS = 6;

/** The stubbed lookup: every word typed must appear in the address. */
export function sampleLookup(source: DeliveryLocatorSource): AddressLookup {
  return {
    search(query) {
      const words = query
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean);
      if (words.length === 0) return Promise.resolve([]);
      const found = source.addresses.filter((place) => {
        const line = addressLine(place).toLowerCase();
        return words.every((word) => line.includes(word));
      });
      return Promise.resolve(found.slice(0, MAX_RESULTS));
    },
    suburbAt(point) {
      let best: Place | null = null;
      let distance = Infinity;
      for (const suburb of source.suburbs) {
        const d = (suburb.point.lat - point.lat) ** 2 + (suburb.point.lng - point.lng) ** 2;
        if (d < distance) {
          distance = d;
          best = suburb;
        }
      }
      return Promise.resolve(best);
    },
    locate({ suburb, postcode }) {
      const name = suburb.toLowerCase();
      const same = source.suburbs.filter((s) => s.postcode === postcode);
      return Promise.resolve(
        same.find((s) => s.suburb.toLowerCase().startsWith(name)) ?? same[0] ?? null,
      );
    },
    delivers() {
      return Promise.resolve(null);
    },
  };
}

/** How long typing must pause before the live search asks (each ask is a paid request). */
export const SEARCH_PAUSE_MS = 250;

interface LiveDeps {
  readonly fetch: typeof fetch;
  /** Checkout's server action `deliveryAreaFor`. */
  readonly area: (postcode: string) => Promise<DeliveryAreaAnswer>;
}

function isPlace(value: unknown): value is Place {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  const point = p['point'] as Record<string, unknown> | undefined;
  return (
    typeof p['id'] === 'string' &&
    typeof p['street'] === 'string' &&
    typeof p['suburb'] === 'string' &&
    typeof p['region'] === 'string' &&
    typeof p['postcode'] === 'string' &&
    typeof point?.['lat'] === 'number' &&
    typeof point['lng'] === 'number'
  );
}

async function getJson(deps: LiveDeps, path: string): Promise<unknown> {
  try {
    const response = await deps.fetch(path, { headers: { accept: 'application/json' } });
    return response.ok ? ((await response.json()) as unknown) : null;
  } catch {
    return null;
  }
}

/**
 * The live lookup: /api/deliver-to/search and /suburb (Mapbox on the server) and the API's
 * delivery area. A failed or throttled answer reads as no result, so the modal shows "No match"
 * or keeps the place found before; the buyer can still search again or move the pin.
 */
export function liveLookup(deps: LiveDeps): AddressLookup {
  let pause: ReturnType<typeof setTimeout> | undefined;
  const search = async (query: string): Promise<readonly Place[]> => {
    const body = (await getJson(deps, `/api/deliver-to/search?q=${encodeURIComponent(query)}`)) as {
      places?: unknown;
    } | null;
    return Array.isArray(body?.places) ? body.places.filter(isPlace) : [];
  };
  return {
    search(query) {
      clearTimeout(pause);
      // Only the last call of a typing burst asks; the earlier ones never answer, and the modal's
      // ticket already ignores them.
      return new Promise((resolve) => {
        pause = setTimeout(() => void search(query).then(resolve), SEARCH_PAUSE_MS);
      });
    },
    async suburbAt(point) {
      const body = (await getJson(
        deps,
        `/api/deliver-to/suburb?lat=${point.lat.toFixed(6)}&lng=${point.lng.toFixed(6)}`,
      )) as { place?: unknown } | null;
      return isPlace(body?.place) ? body.place : null;
    },
    async locate({ suburb, postcode }) {
      const name = suburb.toLowerCase();
      const found = await search(`${suburb} ${postcode}`);
      const place =
        found.find((p) => p.postcode === postcode && p.suburb.toLowerCase() === name) ??
        found.find((p) => p.postcode === postcode);
      // Only the suburb was kept: answer the suburb, not the street address Mapbox matched.
      return place ? { ...place, id: `${place.id}:suburb`, street: '' } : null;
    },
    async delivers(postcode) {
      try {
        const answer = await deps.area(postcode);
        if (answer.kind === 'in') return true;
        if (answer.kind === 'out') return false;
        return null;
      } catch {
        return null;
      }
    },
  };
}
