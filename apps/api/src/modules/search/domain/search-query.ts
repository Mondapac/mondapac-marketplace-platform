import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 48;
/** Deep pages are refused: a storefront narrows the query instead of paging far. */
export const MAX_PAGE = 100;

/** What a visitor asked, as the transport hands it over: text, not yet checked. */
export interface SearchProductsRequest {
  readonly q?: string | undefined;
  readonly category?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

/** A checked request. Exactly one of the two modes: a text search, or a browse by category. */
export interface SearchQuery {
  /** The text to search for, or null when browsing a category. */
  readonly text: string | null;
  readonly categoryId: Id<'Category'> | null;
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
 * must be 2 to 100 characters. An absent or blank `q` needs a `category` (browse). The text is
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
  if (text === null && categoryId === null) return invalid('q', 'required');

  const page = request.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) return invalid('page', 'range');
  const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return invalid('pageSize', 'range');
  }
  return ok({ text, categoryId, page, pageSize });
}
