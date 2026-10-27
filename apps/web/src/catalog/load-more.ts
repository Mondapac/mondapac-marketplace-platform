'use server';

import type { ProductPage } from '../storefront/catalog.ts';
import { LISTING_PAGE_SIZE, findProducts } from '../storefront/catalog.ts';
import { listingStateOf } from './listing-state.ts';

// The server action behind a phone listing's "Load more": the next page of the same listing.
// What the browser sends is input: the scope is length-checked, the filters and sort are read
// back through the listing's own URL parser, and the page is bounded.

export interface LoadMoreRequest {
  readonly scope: {
    readonly q?: string;
    readonly category?: string;
    readonly subcategory?: string;
  };
  /** The listing's query string (filters and sort), as `listingHref` writes it. */
  readonly query: string;
  readonly page: number;
}

const WORDS = /^\P{Cc}{1,100}$/u;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export async function loadMoreProducts(raw: unknown): Promise<ProductPage | null> {
  if (typeof raw !== 'object' || raw === null) return null;
  const { scope, query, page } = raw as Partial<LoadMoreRequest>;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 2 || page > 100) return null;
  if (
    typeof query !== 'string' ||
    query.length > 400 ||
    typeof scope !== 'object' ||
    scope === null
  )
    return null;
  const { q, category, subcategory } = scope;
  if (q !== undefined && (typeof q !== 'string' || !WORDS.test(q))) return null;
  for (const code of [category, subcategory])
    if (code !== undefined && (typeof code !== 'string' || !CODE.test(code))) return null;
  const params = new URLSearchParams(query);
  const state = listingStateOf(Object.fromEntries(params));
  return findProducts({
    ...(q === undefined ? {} : { q }),
    ...(category === undefined ? {} : { category }),
    ...(subcategory === undefined ? {} : { subcategory }),
    ...state,
    page,
    pageSize: LISTING_PAGE_SIZE,
  });
}
