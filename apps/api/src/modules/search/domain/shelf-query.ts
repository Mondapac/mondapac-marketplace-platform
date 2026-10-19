import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { SearchValidationFailed } from './search-query';

/** The most products one shelf read answers: storefront's `MAX_SHELF_PRODUCTS`. */
export const MAX_SHELF_SIZE = 24;
export const DEFAULT_SHELF_SIZE = 12;

/** What the buyer app asked for a shelf, as the transport hands it over. */
export interface ShelfRequest {
  readonly category?: string | undefined;
  readonly limit?: number | undefined;
}

/** A checked shelf request. */
export interface ShelfQuery {
  /** Only Offers of this platform category, or null for the whole Market. */
  readonly categoryId: Id<'Category'> | null;
  readonly limit: number;
}

/** Checks a shelf request (pure): an optional category id and a limit of 1 to 24 (default 12). */
export function parseShelfQuery(request: ShelfRequest): Result<ShelfQuery, SearchValidationFailed> {
  let categoryId: Id<'Category'> | null = null;
  if (request.category !== undefined && request.category !== '') {
    const parsed =
      typeof request.category === 'string' ? parseId<'Category'>(request.category) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'category', code: 'format' }] });
    }
    categoryId = parsed.value;
  }
  const limit = request.limit ?? DEFAULT_SHELF_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SHELF_SIZE) {
    return err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
  }
  return ok({ categoryId, limit });
}
