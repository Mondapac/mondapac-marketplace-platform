import 'server-only';
import type { ApiRead } from './api.ts';
import { productIdOfSegment } from './links.ts';
import { isProductId } from './product-detail.ts';
import { sampleClosedStore } from './sample-unavailable.ts';
import { sampleProduct } from './sample-product.ts';
import { sampleSeller } from './sample-seller.ts';

/** One GET of a public API route; `kind: 'off'` while no API is configured. */
export type MissRead = (path: string) => Promise<ApiRead<unknown>>;

/** The shape of a store slug, as `loadSeller` checks it. */
const STORE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Whether `/p/<segment>` is a product the buyer site has no page for (unknown or removed), decided
 * by the proxy before any HTML is sent, so the 404 body can be real server HTML (Next 16 sends a
 * page's own `notFound()` as an empty shell that the browser fills in after hydration).
 * It asks the same read as `loadProduct` (source.ts) and answers true only for the same "no such
 * product" outcome; an outage or any other answer is false, so the page shows its error state.
 */
export async function productIsMissing(
  segment: string,
  read: MissRead,
  apiOn: boolean,
): Promise<boolean> {
  const id = productIdOfSegment(segment);
  // Only the sample has paths that are not product ids; with the API on they are no product.
  if (!isProductId(id)) return apiOn ? true : sampleProduct(id) === undefined;
  const answer = await read(`search/product-detail/${encodeURIComponent(id.toLowerCase())}`);
  if (answer.kind === 'off') return sampleProduct(id) === undefined;
  return answer.kind === 'failed' && answer.status === 404;
}

/**
 * Whether `/s/<slug>` is a store with no page: unknown, and not a closed store either (a closed
 * store keeps its own 200 page). The same rules as `loadSeller` and `loadClosedStore`.
 */
export async function storeIsMissing(slug: string, read: MissRead): Promise<boolean> {
  if (slug.length > 50 || !STORE_SLUG.test(slug)) return sampleClosedStore(slug) === undefined;
  const answer = await read(`sellers/stores/${encodeURIComponent(slug)}`);
  if (answer.kind === 'off') {
    return sampleSeller(slug) === undefined && sampleClosedStore(slug) === undefined;
  }
  // Only the store module's own answer means "no such store"; a bare 404 is a missing route.
  const none =
    answer.kind === 'failed' && answer.status === 404 && answer.code === 'sellers.store-not-found';
  return none && sampleClosedStore(slug) === undefined;
}
