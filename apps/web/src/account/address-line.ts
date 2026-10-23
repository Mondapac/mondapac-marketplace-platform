import type { SavedAddress } from '../storefront/types.ts';

/** The recipient's full name, the heading of a saved address. */
export function recipientName(address: SavedAddress): string {
  return `${address.firstName} ${address.lastName}`;
}

/** The address as one line ("12 Example Street, Kedron QLD 4031"); the region is the service area's. */
export function addressLine(address: SavedAddress, regionCode: string): string {
  const street = address.line2 ? `${address.street}, ${address.line2}` : address.street;
  return `${street}, ${address.suburb} ${regionCode} ${address.postcode}`;
}
