import 'server-only';
import { NO_SELLER_FILTERS } from '../sellers/sellers-state.ts';
import { SAMPLE_PRODUCTS, sampleSellerId } from './sample-catalog.ts';
import { SAMPLE_SELLER_SLUGS } from './sample-seller.ts';
import { sampleSellers } from './sample-sellers.ts';
import type { ClosedStore, ProductCard, UnavailableProduct } from './types.ts';

// Sample data of the unavailable pages (approved design errors-a-teal v1). It stands in for the
// product and seller reads telling a removed product or a closed store apart from an unknown id,
// until the backend has them; only this file goes when the reads are wired.

const SIMILAR_COUNT = 4;
const OTHER_STORES = 3;

/** Removed sample products: no longer on any listing, but their old links still resolve. */
const REMOVED: Readonly<Record<string, Omit<UnavailableProduct, 'id' | 'similar'>>> = {
  'lamb-leg-roast': {
    name: 'Lamb leg roast, 2 kg',
    category: 'meat',
    imageUrl: '/placeholders/meat.jpg',
    seller: { id: 'kedron', name: 'Kedron Halal Butchers' },
  },
};

/** Closed sample stores: not on the sellers page, but their old links still resolve. */
const CLOSED: Readonly<Record<string, Omit<ClosedStore, 'id' | 'location' | 'others'>>> = {
  'west-end-grocer': { name: 'West End Grocer', city: 'West End', sellingSince: 2025 },
};

/** The same category first, then the same seller. */
function similarTo(product: Omit<UnavailableProduct, 'id' | 'similar'>): ProductCard[] {
  const sameSeller = (p: ProductCard) => sampleSellerId(p) === product.seller.id;
  return [
    ...SAMPLE_PRODUCTS.filter((p) => p.category === product.category),
    ...SAMPLE_PRODUCTS.filter((p) => p.category !== product.category && sameSeller(p)),
  ].slice(0, SIMILAR_COUNT);
}

export function sampleUnavailableProduct(id: string): UnavailableProduct | undefined {
  const product = REMOVED[id];
  return product ? { id, ...product, similar: similarTo(product) } : undefined;
}

export function sampleClosedStore(slug: string): ClosedStore | undefined {
  const store = CLOSED[slug];
  if (!store) return undefined;
  const { items, location } = sampleSellers({
    filters: NO_SELLER_FILTERS,
    sort: 'popular',
    limit: SAMPLE_SELLER_SLUGS.length,
  });
  return {
    id: slug,
    ...store,
    location,
    others: items.filter((s) => s.deliversHere).slice(0, OTHER_STORES),
  };
}
