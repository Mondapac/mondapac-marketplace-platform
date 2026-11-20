import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { parseInstantRange } from '../../../../platform/list-query';
import type { BrandState } from '../../domain/brand';
import { BRAND_STATUSES, type BrandStatus } from '../../domain/brand';

/** The default and largest page of the admin brand list. */
export const BRAND_PAGE_DEFAULT = 25;
export const BRAND_PAGE_MAX = 100;
/** The longest search text of the admin list. */
export const BRAND_SEARCH_MAX = 120;
/** The most open merge-queue groups one answer lists. */
export const MERGE_QUEUE_LIMIT = 200;
/** The most brands the public A to Z list holds; a bigger catalogue needs paging first. */
export const PUBLIC_BRAND_LIMIT = 5000;

export interface ValidationFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

export const invalid = (path: string, code: string): { ok: false; error: ValidationFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ValidationFailure;
  };

export const invalidFields = (
  fields: readonly { readonly path: string; readonly code: string }[],
): { ok: false; error: ValidationFailure } =>
  err({ code: 'validation.failed', fields: [...fields] }) as {
    ok: false;
    error: ValidationFailure;
  };

/** A brand as the admin routes show it. */
export interface BrandView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string | null;
  readonly originCountry: string | null;
  readonly logoImageId: string | null;
  readonly logoAlt: string | null;
  readonly headerImageId: string | null;
  readonly status: BrandStatus;
  readonly proposedBySellerId: string | null;
  readonly approvedBy: string | null;
  readonly mergedIntoId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The version a change must name. */
  readonly version: number;
}

export function viewOf(state: BrandState): BrandView {
  return {
    id: state.id,
    slug: state.slug,
    name: state.name,
    summary: state.summary,
    originCountry: state.originCountry,
    logoImageId: state.logoImageId,
    logoAlt: state.logoAlt,
    headerImageId: state.headerImageId,
    status: state.status,
    proposedBySellerId: state.proposedBySellerId,
    approvedBy: state.approvedBy,
    mergedIntoId: state.mergedIntoId,
    createdAt: state.createdAt.toString(),
    updatedAt: state.updatedAt.toString(),
    version: state.version,
  };
}

/** The admin account of an authenticated admin actor, or null for anyone else. */
export function adminAccountOf(context: CallContext): Id<'Account'> | null {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'admin' ? actor.accountId : null;
}

export function brandIdOf(raw: unknown, path: string): Result<Id<'Brand'>, ValidationFailure> {
  const parsed = typeof raw === 'string' ? parseId<'Brand'>(raw) : null;
  if (parsed === null || !parsed.ok) return invalid(path, 'format');
  return ok(parsed.value);
}

export function versionOf(raw: unknown): Result<number, ValidationFailure> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1)
    return invalid('version', 'type');
  return ok(raw);
}

export function statusFilterOf(raw: unknown): Result<BrandStatus | null, ValidationFailure> {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== 'string' || !(BRAND_STATUSES as readonly string[]).includes(raw)) {
    return invalid('status', 'unknown');
  }
  return ok(raw as BrandStatus);
}

/** The filter keys the admin Brands list and its export both read. */
export const BRAND_FILTER_KEYS = ['status', 'originCountry', 'createdFrom', 'createdTo'] as const;

/** The filter of the admin Brands list (and its export), as {@link brandListFilterOf} reads it. */
export interface BrandListFilter {
  readonly status: BrandStatus | null;
  /** ISO 3166-1 alpha-2, uppercase; exact match on the brand's origin country. */
  readonly originCountry: string | null;
  /** Created at or after this instant (inclusive). */
  readonly createdFrom: Temporal.Instant | null;
  /** Created before this instant (exclusive). */
  readonly createdTo: Temporal.Instant | null;
}

const COUNTRY_CODE = /^[A-Z]{2}$/;
const absentValue = (value: unknown): boolean =>
  value === undefined || value === null || value === '';

/**
 * Reads the list filter of a closed record: `status` (draft, active, archived; anything else is
 * `unknown`), `originCountry` (two uppercase letters, as the brand stores it; anything else, a
 * control character included, is `format`), and `createdFrom` / `createdTo`, ISO 8601 instants with
 * an offset or `Z` (the panel turns the admin's days into instants in the admin's zone, ADR-0005);
 * `createdFrom` is inclusive, `createdTo` exclusive, and a range that ends at or before it starts is
 * `range`. Absent or empty values do not filter.
 */
export function brandListFilterOf(
  record: Readonly<Record<string, unknown>>,
): Result<BrandListFilter, ValidationFailure> {
  const status = statusFilterOf(record['status']);
  if (!status.ok) return status;
  let originCountry: string | null = null;
  const rawCountry = record['originCountry'];
  if (!absentValue(rawCountry)) {
    if (typeof rawCountry !== 'string') return invalid('originCountry', 'type');
    if (!COUNTRY_CODE.test(rawCountry)) return invalid('originCountry', 'format');
    originCountry = rawCountry;
  }
  const range = parseInstantRange({ from: record['createdFrom'], to: record['createdTo'] }, '');
  if (!range.ok) {
    return invalidFields(
      range.error.fields.map((field) => ({
        path: field.path === 'from' ? 'createdFrom' : 'createdTo',
        code: field.code,
      })),
    );
  }
  return ok({
    status: status.value,
    originCountry,
    createdFrom: range.value.from,
    createdTo: range.value.to,
  });
}

/** A closed input: only these keys, as an object. */
export function closedInput(
  input: unknown,
  allowed: readonly string[],
): Result<Record<string, unknown>, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('body', 'type');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    if (!allowed.includes(key)) return invalid(key.slice(0, 64), 'unknown');
  }
  return ok(record);
}
