import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 48;
/** Deep pages are refused: a storefront narrows the query instead of paging far. */
export const MAX_PAGE = 100;

/**
 * The shape of a store address (sellers' shop slug: a-z, 0-9 and single inner hyphens, 3 to 50
 * characters). Search keeps its own copy: it never imports sellers' code. Whether a store with
 * that slug exists and may sell is sellers' answer, never decided here.
 */
export const STORE_SLUG_MIN_LENGTH = 3;
export const STORE_SLUG_MAX_LENGTH = 50;
const STORE_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The shape of a brand address (catalog's brand slug: lower case words joined by single hyphens,
 * at most 80 characters). Search keeps its own copy: whether such a brand exists and is active is
 * catalog's answer, never decided here.
 */
export const BRAND_SLUG_MAX_LENGTH = 80;

/** What a visitor asked, as the transport hands it over: text, not yet checked. */
export interface SearchProductsRequest {
  readonly q?: string | undefined;
  readonly category?: string | undefined;
  /** A store address: lists that store's Offers (no `q`). */
  readonly store?: string | undefined;
  /** A brand address: lists the Offers of that brand's products (no `q`, no `store`). */
  readonly brand?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

/**
 * A checked request. Exactly one of the two modes: a text search, or a browse (by category, by
 * store, or both).
 */
export interface SearchQuery {
  /** The text to search for, or null when browsing a category. */
  readonly text: string | null;
  readonly categoryId: Id<'Category'> | null;
  /** The store address to list, or null. Never with a text. */
  readonly storeSlug: string | null;
  /** The brand address to list, or null. Never with a text or a store. */
  readonly brandSlug: string | null;
  readonly page: number;
  readonly pageSize: number;
}

export interface SearchValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

const invalid = (path: string, code: string): Result<never, SearchValidationFailed> =>
  err({ code: 'validation.failed', fields: [{ path, code }] });

/** Control characters (C0, DEL, C1) and NUL never belong in a search text. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Checks a request (pure). `q` is trimmed and its inner white space collapsed; when present it
 * must be 2 to 100 characters. An absent or blank `q` needs a `category` or a `store` (browse). The text is
 * never interpreted here: it goes to `websearch_to_tsquery` as a bound parameter, which accepts
 * any text and never raises a syntax error.
 */
export function parseSearchQuery(
  request: SearchProductsRequest,
): Result<SearchQuery, SearchValidationFailed> {
  let text: string | null = null;
  if (request.q !== undefined) {
    if (typeof request.q !== 'string' || hasControlCharacter(request.q))
      return invalid('q', 'format');
    const collapsed = request.q.trim().replace(/\s+/gu, ' ');
    if (collapsed !== '') {
      const length = [...collapsed].length;
      if (length < MIN_QUERY_LENGTH) return invalid('q', 'too-short');
      if (length > MAX_QUERY_LENGTH) return invalid('q', 'too-long');
      text = collapsed;
    }
  }
  let categoryId: Id<'Category'> | null = null;
  if (request.category !== undefined && request.category !== '') {
    const parsed =
      typeof request.category === 'string' ? parseId<'Category'>(request.category) : null;
    if (parsed === null || !parsed.ok) return invalid('category', 'format');
    categoryId = parsed.value;
  }
  let storeSlug: string | null = null;
  if (request.store !== undefined && request.store !== '') {
    const slug = request.store;
    if (
      typeof slug !== 'string' ||
      slug.length < STORE_SLUG_MIN_LENGTH ||
      slug.length > STORE_SLUG_MAX_LENGTH ||
      !STORE_SLUG_PATTERN.test(slug)
    ) {
      return invalid('store', 'format');
    }
    // A store's list is a browse by name; text search inside one store is not offered.
    if (text !== null) return invalid('store', 'with-text');
    storeSlug = slug;
  }
  let brandSlug: string | null = null;
  if (request.brand !== undefined && request.brand !== '') {
    const slug = request.brand;
    if (
      typeof slug !== 'string' ||
      slug.length > BRAND_SLUG_MAX_LENGTH ||
      !STORE_SLUG_PATTERN.test(slug)
    ) {
      return invalid('brand', 'format');
    }
    // A brand's list is a browse by name, like a store's; it is not mixed with text or a store.
    if (text !== null) return invalid('brand', 'with-text');
    if (storeSlug !== null) return invalid('brand', 'with-store');
    brandSlug = slug;
  }
  if (text === null && categoryId === null && storeSlug === null && brandSlug === null)
    return invalid('q', 'required');

  const page = request.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) return invalid('page', 'range');
  const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return invalid('pageSize', 'range');
  }
  return ok({ text, categoryId, storeSlug, brandSlug, page, pageSize });
}
