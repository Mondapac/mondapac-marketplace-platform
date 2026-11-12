import 'server-only';
import { findProducts, findStores } from './catalog.ts';
import { productHref } from './links.ts';
import { SAMPLE_PRODUCTS, sampleSellerId } from './sample-catalog.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import type { SuggestAnswer } from '../search/suggest-types.ts';

// Suggestions from the sample catalog while API_BASE_URL is empty: the same shape and the same
// order as `GET search/suggest` (name starts with the words, then name contains them, then a
// seller or category match). Only this file goes when the API is the only source.

const categoryName = (code: string): string | null =>
  SAMPLE_CONTENT.categories.find((c) => c.code === code)?.name ?? null;

const SAMPLE_CAP = 1000;

export async function sampleSuggestions(q: string): Promise<SuggestAnswer> {
  const lower = q.toLowerCase();
  const [page, stores] = await Promise.all([
    findProducts({ q, page: 1, pageSize: SAMPLE_CAP }),
    findStores(q),
  ]);
  const rank = (name: string) =>
    name.toLowerCase().startsWith(lower) ? 0 : name.toLowerCase().includes(lower) ? 1 : 2;
  const ordered = page.items
    .map((p, index) => ({ p, index }))
    .sort((a, b) => rank(a.p.name) - rank(b.p.name) || a.index - b.index);
  const products = ordered.slice(0, 5).map(({ p }) => ({
    id: p.id,
    name: p.name,
    href: productHref(p.id, p.name),
    sellerName: p.sellerName,
    categoryName: categoryName(p.category),
    imageUrl: null,
  }));
  const count = (id: string) =>
    SAMPLE_PRODUCTS.filter((product) => sampleSellerId(product) === id).length;
  return {
    products,
    stores: stores.items.slice(0, 3).map((s) => ({
      slug: s.id,
      href: `/s/${s.id}`,
      name: s.name,
      productCount: s.productCount ?? count(s.id),
    })),
    total: page.total ?? page.items.length,
    totalIsCapped: false,
  };
}
