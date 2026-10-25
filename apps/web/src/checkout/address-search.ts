import type { CheckoutPlace } from '../storefront/types.ts';

// The checkout's address search on sample places: a postcode lists that postcode's suburbs and
// addresses, street text lists addresses, and once a suburb is picked only its streets are listed.
// The address-lookup provider (Mapbox for Deliver to) replaces the list; it answers the same way.

/** Most suggestions in the list. */
export const MAX_SUGGESTIONS = 7;
const MAX_SUBURB_ADDRESSES = 6;
const MAX_POSTCODE_SUBURBS = 3;
const MAX_POSTCODE_ADDRESSES = 4;
const MAX_NAME_SUBURBS = 2;
/** Fewest letters before suburb names are suggested. */
const SUBURB_MIN = 2;

/** A suburb or street address, as typed in one line ("12 Example Street, Kedron QLD 4031"). */
export function placeLine(place: CheckoutPlace): string {
  const area = `${place.suburb} ${place.regionCode} ${place.postcode}`;
  return place.street ? `${place.street}, ${area}` : area;
}

/** Whether the buyer typed (part of) a postcode rather than a street or a suburb. */
export function isPostcodeQuery(query: string): boolean {
  return /^\d+$/.test(query.trim());
}

/**
 * The suggestions for what the buyer typed. `suburb` is the suburb chip already picked: then only
 * its street addresses are listed, filtered by the text.
 */
export function suggestPlaces(
  places: readonly CheckoutPlace[],
  query: string,
  suburb: CheckoutPlace | null,
): readonly CheckoutPlace[] {
  const text = query.trim().toLowerCase();
  const addresses = places.filter((p) => p.street !== '');
  if (suburb)
    return addresses
      .filter(
        (p) =>
          p.suburb === suburb.suburb &&
          p.postcode === suburb.postcode &&
          (text === '' || p.street.toLowerCase().includes(text)),
      )
      .slice(0, MAX_SUBURB_ADDRESSES);
  if (text === '') return [];
  const suburbs = places.filter((p) => p.street === '');
  if (isPostcodeQuery(text))
    return [
      ...suburbs.filter((p) => p.postcode.startsWith(text)).slice(0, MAX_POSTCODE_SUBURBS),
      ...addresses.filter((p) => p.postcode.startsWith(text)).slice(0, MAX_POSTCODE_ADDRESSES),
    ];
  const named =
    text.length >= SUBURB_MIN
      ? suburbs.filter((p) => p.suburb.toLowerCase().startsWith(text)).slice(0, MAX_NAME_SUBURBS)
      : [];
  return [
    ...named,
    ...addresses
      .filter((p) => placeLine(p).toLowerCase().includes(text))
      .slice(0, MAX_SUGGESTIONS - named.length),
  ];
}
