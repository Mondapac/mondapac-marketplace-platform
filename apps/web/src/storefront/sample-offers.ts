import 'server-only';
import { SAMPLE_PRODUCTS } from './sample-catalog.ts';
import type { OffersPage } from './offers.ts';

/** Sample specials, for the buyer site while API_BASE_URL is empty: the products with a was price. */
export function sampleOffers(): OffersPage {
  return { kind: 'ok', items: SAMPLE_PRODUCTS.filter((p) => p.wasPrice !== undefined) };
}
