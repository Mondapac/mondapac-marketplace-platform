'use server';

import { checkDeliveryArea } from '../storefront/source.ts';
import type { DeliveryAreaAnswer } from '../storefront/types.ts';

// The checkout's server actions: the storefront's BFF side of checkout. Next.js refuses a server
// action whose Origin is not this host. The postcode a buyer types is never logged.

/** Whether the Market delivers to a new address's postcode. */
export async function deliveryAreaFor(raw: unknown): Promise<DeliveryAreaAnswer> {
  if (typeof raw !== 'string') return { kind: 'failed' };
  return checkDeliveryArea(raw);
}
