import { cardsOf } from './home-source.ts';
import type { PhotoUrl } from './photos.ts';
import type { StoreProducts } from './types.ts';

// The seller page's Products tab on real data: `GET search/products?store=<slug>`, a page of the
// store's Offers by name. The answer is untrusted, so it is read through the same card parser as
// the home shelves (a bad item is dropped, a bad page is a failed read, never half a page).

/** Cards per page of the Products tab. */
export const STORE_PAGE_SIZE = 24;
/** The API refuses a page beyond this (search `MAX_PAGE`). */
export const STORE_MAX_PAGE = 100;

/** The page number of a `?page=` value: a whole number from 1 up, else 1. */
export function storePageOf(value: string | string[] | undefined): number {
  if (typeof value !== 'string' || !/^[0-9]{1,3}$/u.test(value)) return 1;
  const page = Number(value);
  return page >= 1 && page <= STORE_MAX_PAGE ? page : 1;
}

/** The API path of one page of a store's products; `slug` is already checked. */
export function storeProductsPath(slug: string, page: number): string {
  const params = new URLSearchParams({
    store: slug,
    page: String(page),
    pageSize: String(STORE_PAGE_SIZE),
  });
  return `search/products?${params.toString()}`;
}

/**
 * The tab's content from the API's answer. A body that is not a page (no `items` list, no boolean
 * `hasMore`) is `failed`: the tab says so, the rest of the page stays.
 */
export function storeProductsOf(
  body: unknown,
  page: number,
  slugs: ReadonlyMap<string, string>,
  photo: PhotoUrl | null,
): StoreProducts {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'failed', page };
  }
  const { items, hasMore } = body as { items?: unknown; hasMore?: unknown };
  if (!Array.isArray(items) || typeof hasMore !== 'boolean') return { kind: 'failed', page };
  return { kind: 'ok', items: cardsOf({ items }, slugs, photo), page, hasMore };
}
