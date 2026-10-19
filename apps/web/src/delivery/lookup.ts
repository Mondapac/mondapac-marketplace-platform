import type { DeliveryLocatorSource, GeoPoint, Place } from '../storefront/types.ts';
import type { DeliverTo } from './deliver-to.ts';
import { addressLine } from './geo.ts';

/**
 * The address lookup behind the Deliver to modal. The provider (cost, privacy, Australian address
 * data) is john's decision; until then `sampleLookup` answers from sample places. A real
 * provider implements the same calls.
 */
export interface AddressLookup {
  /** Addresses matching what the buyer typed, best first. */
  search(query: string): Promise<readonly Place[]>;
  /** The suburb at a point (reverse geocoding), or null when there is none. */
  suburbAt(point: GeoPoint): Promise<Place | null>;
  /** The suburb a buyer chose before (a guest keeps only its name and postcode). */
  locate(area: DeliverTo): Promise<Place | null>;
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
  };
}
