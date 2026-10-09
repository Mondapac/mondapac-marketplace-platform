import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

/** The default and largest page of a seller list. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 50;

export type ReadFailureCode =
  | 'access.denied'
  | 'access.unavailable'
  | 'validation.failed'
  | 'product.not-found'
  | 'offer.not-found';

export interface ValidationFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

export const invalid = (path: string, code: string): { ok: false; error: ValidationFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ValidationFailure;
  };

/** The seller of an authenticated seller actor, or null for anyone else. */
export function sellerOf(context: CallContext): Id<'Seller'> | null {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'seller' ? actor.sellerId : null;
}

/** A closed page request: an optional previous-page id and an optional size in 1 to 50. */
export function parsePage<K extends string>(
  input: unknown,
): Result<{ afterId: Id<K> | null; limit: number }, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('query', 'type');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'afterId' && key !== 'limit') return invalid(key, 'unknown');
  }
  let afterId: Id<K> | null = null;
  if (record['afterId'] !== undefined && record['afterId'] !== null) {
    const parsed = typeof record['afterId'] === 'string' ? parseId<K>(record['afterId']) : null;
    if (parsed === null || !parsed.ok) return invalid('afterId', 'format');
    afterId = parsed.value;
  }
  let limit = DEFAULT_PAGE_SIZE;
  if (record['limit'] !== undefined && record['limit'] !== null) {
    const value = record['limit'];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_PAGE_SIZE
    ) {
      return invalid('limit', 'range');
    }
    limit = value;
  }
  return ok({ afterId, limit });
}

export const isoOf = (instant: { toString(): string } | null): string | null =>
  instant === null ? null : instant.toString();
