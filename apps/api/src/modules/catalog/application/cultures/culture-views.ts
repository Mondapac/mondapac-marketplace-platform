import { ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  CULTURE_STATUSES,
  isCultureNamePublished,
  type CultureName,
  type CultureState,
  type CultureStatus,
} from '../../domain/culture';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import { invalid, type ValidationFailure } from '../business-activities/business-activity-views';

// The helpers every culture use case shares. The input helpers are the ones of the business-activity
// package (same closed-body and version rules); the view and the claim check are the culture's own.
export {
  adminAccountOf,
  closedInput,
  invalid,
  invalidFields,
  versionOf,
  type ValidationFailure,
} from '../business-activities/business-activity-views';

export const CULTURE_SEARCH_MAX = 80;

/** A culture as the admin routes show it. Counts of sellers and products come with later packages. */
export interface CultureView {
  readonly id: string;
  readonly code: string;
  readonly status: CultureStatus;
  readonly displayOrder: number;
  readonly requiredCertificationType: string | null;
  readonly badgeColour: string | null;
  readonly isDefault: boolean;
  readonly names: Readonly<
    Record<string, { readonly name: string; readonly description: string | null }>
  >;
  /** The locales whose name and description both exist; only these are ever shown to a buyer. */
  readonly publishedLocales: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The version a change must name. */
  readonly version: number;
}

export function viewOf(state: CultureState): CultureView {
  return {
    id: state.id,
    code: state.code,
    status: state.status,
    displayOrder: state.displayOrder,
    requiredCertificationType: state.requiredCertificationType,
    badgeColour: state.badgeColour,
    isDefault: state.isDefault,
    names: Object.fromEntries(
      state.names.map((entry) => [
        entry.locale,
        { name: entry.name, description: entry.description },
      ]),
    ),
    publishedLocales: state.names.filter(isCultureNamePublished).map((entry) => entry.locale),
    createdAt: state.createdAt.toString(),
    updatedAt: state.updatedAt.toString(),
    version: state.version,
  };
}

export function cultureIdOf(raw: unknown, path: string): Result<Id<'Culture'>, ValidationFailure> {
  const parsed = typeof raw === 'string' ? parseId<'Culture'>(raw) : null;
  if (parsed === null || !parsed.ok) return invalid(path, 'format');
  return ok(parsed.value);
}

export function categoryIdOf(
  raw: unknown,
  path: string,
): Result<Id<'Category'>, ValidationFailure> {
  const parsed = typeof raw === 'string' ? parseId<'Category'>(raw) : null;
  if (parsed === null || !parsed.ok) return invalid(path, 'format');
  return ok(parsed.value);
}

export function statusOf(raw: unknown, path: string): Result<CultureStatus, ValidationFailure> {
  if (typeof raw !== 'string' || !(CULTURE_STATUSES as readonly string[]).includes(raw)) {
    return invalid(path, 'unknown');
  }
  return ok(raw as CultureStatus);
}

export type CultureClaimWordFailure =
  | {
      readonly code: 'culture.claim-word';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | {
      // A text in a locale with no claim terms configured cannot be checked (ADR-0047 decision 10):
      // refused, never let through.
      readonly code: 'culture.locale-uncheckable';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.unavailable' };

/**
 * Refuses a name or description that asserts a certification (halal and the like): a culture's text
 * is a label for a community, never a claim (ADR-0047 decision 10). Only texts that differ from
 * `stored` are checked, so an edit that does not touch a text (an unchanged text is not asked
 * again) can still be saved; every new or changed text is checked, and only in a locale in which
 * certification has claim terms (`claimLocales`; else `culture.locale-uncheckable`, fail closed,
 * ADR-0047 decision 10). A `code`
 * (on create and in the seed) is checked as a text too, in the Market's default locale. Runs
 * outside any unit (the matcher opens its own); an unavailable matcher fails closed.
 */
export async function refuseClaimWords(
  deps: { readonly matcher: ClaimTextMatcher; readonly claimLocales: ClaimTermLocales },
  context: CallContext,
  names: readonly CultureName[],
  stored: readonly CultureName[] = [],
  code?: { readonly text: string; readonly locale: string },
): Promise<CultureClaimWordFailure | null> {
  const before = new Map(stored.map((entry) => [entry.locale, entry] as const));
  const texts: { path: string; locale: string; text: string }[] = [];
  for (const entry of names) {
    const old = before.get(entry.locale);
    if (old?.name !== entry.name) {
      texts.push({ path: `names.${entry.locale}.name`, locale: entry.locale, text: entry.name });
    }
    if (entry.description !== null && old?.description !== entry.description) {
      texts.push({
        path: `names.${entry.locale}.description`,
        locale: entry.locale,
        text: entry.description,
      });
    }
  }
  if (code !== undefined) {
    // The code is a label too (it may reach an address later): `halal-certified` is refused.
    texts.push({ path: 'code', locale: code.locale, text: code.text });
  }
  if (texts.length === 0) return null;
  const covered = await deps.claimLocales.covered(context).catch(() => null);
  if (covered === null || !covered.ok) return { code: 'access.unavailable' };
  const uncheckable = texts
    .filter((t) => !covered.value.includes(t.locale))
    .map((t) => ({ path: t.path, code: 'locale-uncheckable' }));
  if (uncheckable.length > 0) return { code: 'culture.locale-uncheckable', fields: uncheckable };
  const answer = await deps.matcher.match(
    context,
    texts.map(({ locale, text }) => ({ locale, text })),
  );
  if (!answer.ok || answer.value.length !== texts.length) return { code: 'access.unavailable' };
  const fields = texts
    .filter((_, index) => answer.value[index]!.length > 0)
    .map((t) => ({ path: t.path, code: 'claim-word' }));
  return fields.length > 0 ? { code: 'culture.claim-word', fields } : null;
}
