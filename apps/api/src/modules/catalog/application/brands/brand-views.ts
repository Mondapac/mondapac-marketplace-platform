import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
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
