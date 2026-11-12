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
  /** Addresses and suburbs matching what the buyer typed, best first (closer to `near` first). */
  search(query: string, near?: GeoPoint): Promise<readonly Place[]>;
  /** The suburb at a point (reverse geocoding), or null when there is none. */
  suburbAt(point: GeoPoint): Promise<Place | null>;
  /** The suburb a buyer chose before (a guest keeps only its name and postcode). */
  locate(area: DeliverTo): Promise<Place | null>;
  /**
   * Whether the Market delivers to a postcode, or null when nobody could say: the modal then
   * previews with the area's boundary, and checkout checks again before it takes an order.
   */
  delivers(postcode: string): Promise<boolean | null>;
  /**
   * The street address to save in the address book, asked again so it may be stored (Mapbox's
   * permanent answer), or null when it could not be.
   */
  keep(place: Place): Promise<Place | null>;
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
    keep(place) {
      // Sample places are ours to keep.
      return Promise.resolve(place);
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

/** Why a live search has no list: too many searches from this buyer, or the search failed. */
export class SearchProblem extends Error {
  constructor(readonly kind: 'throttled' | 'failed') {
    super(`address search ${kind}`);
  }
}

async function getJson(deps: LiveDeps, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await deps.fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    throw new SearchProblem('failed');
  }
  if (response.status === 429) throw new SearchProblem('throttled');
  if (!response.ok) throw new SearchProblem('failed');
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new SearchProblem('failed');
  }
}

/**
 * The live lookup: /api/deliver-to/search and /suburb (Mapbox on the server) and the API's
 * delivery area. `search` rejects with a SearchProblem when it could not search, so the modal
 * says so instead of "No match"; a failed reverse lookup or locate answers null and the modal
 * keeps the place found before.
 */
export function liveLookup(deps: LiveDeps): AddressLookup {
  let pause: ReturnType<typeof setTimeout> | undefined;
  const search = async (query: string, near?: GeoPoint): Promise<readonly Place[]> => {
    const nearParam = near ? `&near=${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : '';
    const path = `/api/deliver-to/search?q=${encodeURIComponent(query)}${nearParam}`;
    const body = (await getJson(deps, path)) as {
      places?: unknown;
    } | null;
    return Array.isArray(body?.places) ? body.places.filter(isPlace) : [];
  };
  return {
    search(query, near) {
      clearTimeout(pause);
      // Only the last call of a typing burst asks; the earlier ones never answer, and the modal's
      // ticket already ignores them.
      return new Promise((resolve, reject) => {
        pause = setTimeout(() => void search(query, near).then(resolve, reject), SEARCH_PAUSE_MS);
      });
    },
    async suburbAt(point) {
      const body = (await getJson(
        deps,
        `/api/deliver-to/suburb?lat=${point.lat.toFixed(6)}&lng=${point.lng.toFixed(6)}`,
      ).catch(() => null)) as { place?: unknown } | null;
      return isPlace(body?.place) ? body.place : null;
    },
    async locate({ suburb, postcode }) {
      const name = suburb.toLowerCase();
      const found = await search(`${suburb} ${postcode}`).catch(() => []);
      const place =
        found.find((p) => p.postcode === postcode && p.suburb.toLowerCase() === name) ??
        found.find((p) => p.postcode === postcode);
      // Only the suburb was kept: answer the suburb, not the street address Mapbox matched.
      return place ? { ...place, id: `${place.postcode}:${place.suburb}`, street: '' } : null;
    },
    async keep(place) {
      const body = (await getJson(
        deps,
        `/api/deliver-to/keep?q=${encodeURIComponent(addressLine(place))}`,
      ).catch(() => null)) as { place?: unknown } | null;
      return isPlace(body?.place) && body.place.street !== '' ? body.place : null;
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
