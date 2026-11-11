import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import {
  VARIANT_ISSUES,
  type VariantIssue,
  type VariantRow,
  type VariantsQuery,
} from '../ports/variant-admin.reader';

// The shared input rules of the admin Variants page's reads (variants V6): an admin caller, a
// closed query, and the issues of a row.

export const DEFAULT_VARIANTS_LIMIT = 25;
export const MAX_VARIANTS_LIMIT = 100;
/** The longest search text; a longer one is refused, never cut. */
export const MAX_VARIANTS_TEXT = 100;
/** The most variant types one Market lists (each is a definition with values). */
export const MAX_VARIANT_TYPES = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

export type AdminReadFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

/** True for an authenticated admin (the rule's population); the key is the gate's. */
export function isAdmin(context: CallContext): boolean {
  return context.actor.kind === 'authenticated' && context.actor.population === 'admin';
}

/** A closed query object: only `allowed` keys. */
export function closedQuery(
  input: unknown,
  allowed: readonly string[],
): Result<Record<string, unknown>, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('query', 'type');
  }
  for (const key of Object.keys(input).sort()) {
    if (!allowed.includes(key)) return invalid(key.slice(0, 64), 'unknown');
  }
  return ok(input as Record<string, unknown>);
}

const empty = (value: unknown) => value === undefined || value === null || value === '';

/** The keys of the Variants tab's filter (the list, the counts and the export share them). */
export const FILTER_KEYS = ['q', 'typeCode', 'issue'] as const;

export interface VariantsFilter {
  readonly text: string | null;
  readonly typeCode: string | null;
  readonly issue: VariantIssue | null;
}

export function parseFilter(
  query: Record<string, unknown>,
): Result<VariantsFilter, ValidationFailure> {
  let text: string | null = null;
  if (!empty(query['q'])) {
    if (typeof query['q'] !== 'string') return invalid('q', 'type');
    const trimmed = query['q'].trim();
    if ([...trimmed].length > MAX_VARIANTS_TEXT) return invalid('q', 'length');
    if (/\p{Cc}/u.test(trimmed)) return invalid('q', 'format');
    text = trimmed === '' ? null : trimmed;
  }
  let typeCode: string | null = null;
  if (!empty(query['typeCode'])) {
    if (typeof query['typeCode'] !== 'string' || !CODE.test(query['typeCode'])) {
      return invalid('typeCode', 'format');
    }
    typeCode = query['typeCode'];
  }
  let issue: VariantIssue | null = null;
  if (!empty(query['issue'])) {
    if (!(VARIANT_ISSUES as readonly unknown[]).includes(query['issue'])) {
      return invalid('issue', 'value');
    }
    issue = query['issue'] as VariantIssue;
  }
  return ok({ text, typeCode, issue });
}

export function parseAfter(raw: unknown): Result<string | null, ValidationFailure> {
  if (empty(raw)) return ok(null);
  if (typeof raw !== 'string' || !UUID.test(raw)) return invalid('after', 'format');
  return ok(raw.toLowerCase());
}

export function parseLimit(raw: unknown): Result<number, ValidationFailure> {
  if (empty(raw)) return ok(DEFAULT_VARIANTS_LIMIT);
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_VARIANTS_LIMIT) {
    return invalid('limit', 'range');
  }
  return ok(raw);
}

export function definitionIdOf(raw: unknown): Id<'AttributeDefinition'> | null {
  const parsed = typeof raw === 'string' ? parseId<'AttributeDefinition'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/** Every issue a row has, in the order of {@link VARIANT_ISSUES}. */
export function issuesOf(row: VariantRow): VariantIssue[] {
  const issues: VariantIssue[] = [];
  if (row.sellers === 0) issues.push('no-seller-selling');
  if (row.gtin === null) issues.push('missing-gtin');
  if (row.duplicateGtin) issues.push('duplicate-gtin');
  if (row.ownImages === 0 && row.productImages === 0) issues.push('no-image');
  if (row.missingLocales.length > 0) issues.push('missing-language');
  return issues;
}

/** The reader's query for a parsed filter. */
export function queryOf(
  filter: VariantsFilter,
  page: { readonly after: string | null; readonly limit: number },
  locales: { readonly default: string; readonly supported: readonly string[] },
): VariantsQuery {
  return {
    ...filter,
    after: page.after,
    limit: page.limit,
    locale: locales.default,
    locales: locales.supported,
  };
}

/** The Market's locales, or `access.unavailable` when its configuration cannot be read. */
export function localesOf(
  policy: CatalogMarketPolicy,
  context: CallContext,
): Result<{ readonly default: string; readonly supported: readonly string[] }, AdminReadFailure> {
  try {
    return ok(policy.locales(context.market));
  } catch {
    return err({ code: 'access.unavailable' });
  }
}
