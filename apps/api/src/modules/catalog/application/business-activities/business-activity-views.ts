import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  BUSINESS_ACTIVITY_STATUSES,
  type BusinessActivityState,
  type BusinessActivityStatus,
} from '../../domain/business-activity';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';

export const ACTIVITY_PAGE_DEFAULT = 25;
export const ACTIVITY_PAGE_MAX = 100;
export const ACTIVITY_SEARCH_MAX = 80;

export interface ValidationFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

export const invalid = (path: string, code: string): { ok: false; error: ValidationFailure } =>
  invalidFields([{ path, code }]);

export const invalidFields = (
  fields: readonly { readonly path: string; readonly code: string }[],
): { ok: false; error: ValidationFailure } =>
  err({ code: 'validation.failed', fields: [...fields] }) as {
    ok: false;
    error: ValidationFailure;
  };

/** An activity as the admin routes show it. */
export interface BusinessActivityView {
  readonly id: string;
  readonly code: string;
  readonly status: BusinessActivityStatus;
  readonly names: Readonly<Record<string, string>>;
  readonly description: string | null;
  readonly categoryIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The version a change must name. */
  readonly version: number;
}

export function viewOf(state: BusinessActivityState): BusinessActivityView {
  return {
    id: state.id,
    code: state.code,
    status: state.status,
    names: Object.fromEntries(state.names.map((entry) => [entry.locale, entry.name])),
    description: state.description,
    categoryIds: state.categoryIds,
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

export function activityIdOf(
  raw: unknown,
  path: string,
): Result<Id<'BusinessActivity'>, ValidationFailure> {
  const parsed = typeof raw === 'string' ? parseId<'BusinessActivity'>(raw) : null;
  if (parsed === null || !parsed.ok) return invalid(path, 'format');
  return ok(parsed.value);
}

export function versionOf(raw: unknown): Result<number, ValidationFailure> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1)
    return invalid('version', 'type');
  return ok(raw);
}

export function statusOf(
  raw: unknown,
  path: string,
): Result<BusinessActivityStatus, ValidationFailure> {
  if (typeof raw !== 'string' || !(BUSINESS_ACTIVITY_STATUSES as readonly string[]).includes(raw)) {
    return invalid(path, 'unknown');
  }
  return ok(raw as BusinessActivityStatus);
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

export type ClaimWordFailure =
  | {
      readonly code: 'business-activity.claim-word';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.unavailable' };

/**
 * Refuses a name or description that asserts a certification (halal and the like): an activity is a
 * business scope, never a claim. Runs the claim-term matcher outside any unit (it opens its own);
 * an unavailable matcher fails closed.
 */
export async function refuseClaimWords(
  matcher: ClaimTextMatcher,
  context: CallContext,
  content: {
    readonly names: readonly { readonly locale: string; readonly name: string }[];
    readonly description: string | null;
  },
): Promise<ClaimWordFailure | null> {
  const texts = [
    ...content.names.map((entry) => ({
      path: `names.${entry.locale}`,
      locale: entry.locale,
      text: entry.name,
    })),
    ...(content.description === null
      ? []
      : [
          {
            path: 'description',
            locale: content.names[0]?.locale ?? 'en',
            text: content.description,
          },
        ]),
  ];
  const answer = await matcher.match(
    context,
    texts.map(({ locale, text }) => ({ locale, text })),
  );
  if (!answer.ok || answer.value.length !== texts.length) return { code: 'access.unavailable' };
  const fields = texts
    .filter((_, index) => answer.value[index]!.length > 0)
    .map((t) => ({ path: t.path, code: 'claim-word' }));
  return fields.length > 0 ? { code: 'business-activity.claim-word', fields } : null;
}
