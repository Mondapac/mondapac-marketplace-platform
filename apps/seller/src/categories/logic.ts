import type { ApiFailure } from '../api/client.ts';
import type { CategoryLocales, ParentCategory, ShelfText } from './types.ts';

/** Persian, Arabic, Hebrew and Urdu inputs read right to left. */
export function isRtl(locale: string): boolean {
  return /^(fa|ar|he|ur)(-|$)/i.test(locale);
}

/** The language name in English ("Persian"); the code itself when the runtime does not know it. */
export function localeName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** The locales to offer: the default first (required), then the other supported ones. */
export function orderedLocales(locales: CategoryLocales): readonly string[] {
  return [locales.default, ...locales.supported.filter((locale) => locale !== locales.default)];
}

/** The text in the default locale, else the first one; null when there is none. */
export function nameOf(texts: readonly ShelfText[], defaultLocale: string): string | null {
  const text = texts.find((entry) => entry.locale === defaultLocale) ?? texts[0];
  return text?.name ?? null;
}

/** "Grocery / Pantry / Oils" for every category, sorted by that label. */
export function parentOptions(
  categories: readonly ParentCategory[],
  defaultLocale: string,
): readonly { readonly value: string; readonly label: string }[] {
  const byId = new Map(categories.map((category) => [category.categoryId, category]));
  const label = (category: ParentCategory, depth = 0): string => {
    const own = category.names[defaultLocale] ?? Object.values(category.names)[0] ?? '';
    const parent = category.parentId === null ? undefined : byId.get(category.parentId);
    return parent === undefined || depth > 8 ? own : `${label(parent, depth + 1)} / ${own}`;
  };
  return categories
    .map((category) => ({ value: category.categoryId, label: label(category) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en'));
}

export interface FilledText {
  readonly name: string;
  readonly shortDescription: string;
}

/** The request's `texts`: only locales with a name; a blank description is left out. */
export function textsBody(
  filled: Readonly<Record<string, FilledText>>,
): Record<string, { name: string; shortDescription?: string }> {
  const body: Record<string, { name: string; shortDescription?: string }> = {};
  for (const [locale, text] of Object.entries(filled)) {
    const name = text.name.trim();
    if (name === '') continue;
    const description = text.shortDescription.trim();
    body[locale] = description === '' ? { name } : { name, shortDescription: description };
  }
  return body;
}

export interface FieldProblem {
  readonly locale: string;
  readonly field: 'name' | 'shortDescription';
  /** A key under `categories.proposals.error.field`. */
  readonly kind: string;
}

export interface ProposeProblem {
  /** A key under `categories.proposals.error`. */
  readonly form: string;
  readonly fields: readonly FieldProblem[];
  readonly max?: number;
}

const BY_CODE: Readonly<Record<string, string>> = {
  'category-proposal.not-allowed': 'not-allowed',
  'seller.not-eligible': 'not-eligible',
  'access.seller-not-approved': 'not-eligible',
  'category-proposal.duplicate': 'duplicate',
  'category-proposal.limit': 'limit',
  'category.parent-not-found': 'parent-not-found',
  'category.claim-word': 'claim-word',
  'category.locale-uncheckable': 'locale-uncheckable',
  'category.required-locale-missing': 'required-locale-missing',
  'claim-text.check-unavailable': 'check-unavailable',
  'request.throttled': 'throttled',
  'conflict.stale': 'stale',
  'category-proposal.not-found': 'not-found',
  'category-proposal.not-pending': 'not-pending',
  'access.denied': 'denied',
  'request.csrf': 'denied',
};

const FIELD_KIND: Readonly<Record<string, string>> = {
  'claim-word': 'claim-word',
  'blocked-term': 'blocked-term',
  'locale-uncheckable': 'locale-uncheckable',
  required: 'required',
};

function fieldProblems(failure: ApiFailure): readonly FieldProblem[] {
  const out: FieldProblem[] = [];
  for (const entry of failure.details?.fields ?? []) {
    const match = /^texts\.([^.]+)\.(name|shortDescription)$/.exec(entry.path);
    if (match === null) continue;
    out.push({
      locale: match[1] ?? '',
      field: match[2] as 'name' | 'shortDescription',
      kind: FIELD_KIND[entry.code] ?? 'invalid',
    });
  }
  return out;
}

/**
 * The problem of a failed propose or cancel, as message keys. A refused word is never named: the
 * API sends only the field and the kind, and the copy says which field to change.
 */
export function proposalProblemOf(failure: ApiFailure): ProposeProblem {
  if (failure.status === 0 || failure.status >= 500) {
    const named = failure.code === 'claim-text.check-unavailable' ? 'check-unavailable' : null;
    return { form: named ?? 'unreachable', fields: [] };
  }
  const named = BY_CODE[failure.code];
  if (named !== undefined) {
    return {
      form: named,
      fields: fieldProblems(failure),
      ...(failure.details?.max === undefined ? {} : { max: failure.details.max }),
    };
  }
  if (failure.code === 'validation.failed') {
    const fields = fieldProblems(failure);
    return { form: fields.length > 0 ? 'validation-fields' : 'validation', fields };
  }
  return { form: 'unknown', fields: [] };
}

/** The problem of a failed shelf change on an Offer, as a key under `categories.shelf.error`. */
export function shelfProblemOf(failure: ApiFailure): string {
  if (failure.status === 0 || failure.status >= 500) return 'unreachable';
  switch (failure.code) {
    case 'conflict.stale':
      return 'stale';
    case 'seller-category.not-found':
      return 'shelf-not-found';
    case 'offer.not-found':
      return 'offer-not-found';
    case 'access.denied':
    case 'access.seller-not-approved':
    case 'request.csrf':
      return 'denied';
    default:
      return 'unknown';
  }
}
