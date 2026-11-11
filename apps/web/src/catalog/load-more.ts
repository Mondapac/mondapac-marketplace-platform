'use server';

import type { ProductPage } from '../storefront/catalog.ts';
import { LISTING_PAGE_SIZE, findProducts } from '../storefront/catalog.ts';
import { liveFiltersOf } from './live-filters.ts';
import { listingStateOf } from './listing-state.ts';

// The server action behind a phone listing's "Load more": the next page of the same listing.
// What the browser sends is input: the scope is length-checked, the filters and sort are read
// back through the listing's own URL parser, and the page is bounded.

export interface LoadMoreRequest {
  readonly scope: {
    readonly q?: string;
    readonly category?: string;
    readonly subcategory?: string;
    /** Only the products on the category itself ("Other {name}"). */
    readonly direct?: boolean;
  };
  /** The listing's query string (filters and sort), as `listingHref` writes it on its address. */
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
    query.length > 2000 ||
    typeof scope !== 'object' ||
    scope === null
  )
    return null;
  const { q, category, subcategory, direct } = scope;
  if (direct !== undefined && (typeof direct !== 'boolean' || category === undefined)) return null;
  if (q !== undefined && (typeof q !== 'string' || !WORDS.test(q))) return null;
  for (const code of [category, subcategory])
    if (code !== undefined && (typeof code !== 'string' || !CODE.test(code))) return null;
  const params = new URLSearchParams(query);
  const record: Record<string, string | string[]> = Object.fromEntries(params);
  // `filter` comes once per attribute: all of them, not the last one.
  record.filter = params.getAll('filter');
  const state = listingStateOf(record);
  return findProducts({
    ...(q === undefined ? {} : { q }),
    ...(category === undefined ? {} : { category }),
    ...(subcategory === undefined ? {} : { subcategory }),
    ...(direct === true ? { direct } : {}),
    ...state,
    live: liveFiltersOf(record),
    page,
    pageSize: LISTING_PAGE_SIZE,
  });
}
