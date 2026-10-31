import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';

// The business activity entity (catalog business-activity package; ADR-0040). An activity such as
// Grocery or Butcher is defined by an admin per Market. It carries a multilingual name, a short
// description and the category branches (level 1 or 2 of the tree, descendants inherit) a seller
// with this activity may reach.
//
//   active <---> inactive
//
// The code is fixed at creation. An activity is deleted only while no seller uses it (the use case
// asks sellers through a port); otherwise it is made inactive.

export const BUSINESS_ACTIVITY_STATUSES = ['active', 'inactive'] as const;
export type BusinessActivityStatus = (typeof BUSINESS_ACTIVITY_STATUSES)[number];

export const ACTIVITY_CODE_MAX = 40;
export const ACTIVITY_NAME_MAX = 80;
export const ACTIVITY_DESCRIPTION_MAX = 300;
/** The most category branches one activity may link. */
export const ACTIVITY_CATEGORIES_MAX = 100;
/** The deepest tree level a linked branch may sit on (0 is a top-level category). */
export const ACTIVITY_CATEGORY_MAX_DEPTH = 1;

const CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Control, format and separator characters other than a plain space: never part of a text. */
const HIDDEN_OR_CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;

export const isActivityCode = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= ACTIVITY_CODE_MAX && CODE_PATTERN.test(value);

/** Inner runs of whitespace become one space and the ends are trimmed. */
export const tidyActivityText = (raw: string): string => raw.replace(/\s+/gu, ' ').trim();

/** The code a name suggests: lower case ASCII words joined by hyphens; `activity` when none is left. */
export function suggestActivityCode(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, ACTIVITY_CODE_MAX)
    .replace(/-+$/gu, '');
  return words === '' ? 'activity' : words;
}

export interface ActivityFieldProblem {
  readonly path: string;
  readonly code: string;
}

/** The editable content of an activity, validated. Names are by locale, in code order. */
export interface BusinessActivityContent {
  readonly names: readonly { readonly locale: string; readonly name: string }[];
  readonly description: string | null;
  readonly categoryIds: readonly Id<'Category'>[];
}

export interface ActivityLocales {
  /** The locale whose name is required. */
  readonly required: string;
  readonly supported: readonly string[];
}

/**
 * Validates the content of a create or an edit. Every field is judged and the problems come back
 * together. Names: an object of locale to text; the required locale must be present, every locale
 * must be supported, a name is 1 to 80 characters without control characters and no two locales
 * of one activity may repeat a name.
 */
export function parseActivityContent(
  input: {
    readonly names?: unknown;
    readonly description?: unknown;
    readonly categoryIds?: unknown;
  },
  locales: ActivityLocales,
): Result<BusinessActivityContent, readonly ActivityFieldProblem[]> {
  const problems: ActivityFieldProblem[] = [];
  const names: { locale: string; name: string }[] = [];

  const rawNames = input.names;
  if (typeof rawNames !== 'object' || rawNames === null || Array.isArray(rawNames)) {
    problems.push({ path: 'names', code: 'type' });
  } else {
    for (const locale of Object.keys(rawNames).sort()) {
      const path = `names.${locale.slice(0, 16)}`;
      const raw = (rawNames as Record<string, unknown>)[locale];
      if (!LOCALE_PATTERN.test(locale) || !locales.supported.includes(locale)) {
        problems.push({ path, code: 'locale-unsupported' });
        continue;
      }
      if (typeof raw !== 'string') {
        problems.push({ path, code: 'type' });
        continue;
      }
      const tidy = tidyActivityText(raw);
      if (tidy === '') continue; // an empty name is the same as no name for that locale
      if (tidy.length > ACTIVITY_NAME_MAX) problems.push({ path, code: 'too-long' });
      else if (HIDDEN_OR_CONTROL.test(tidy)) problems.push({ path, code: 'chars' });
      else names.push({ locale, name: tidy });
    }
    const requiredPath = `names.${locales.required}`;
    if (
      !names.some((entry) => entry.locale === locales.required) &&
      !problems.some((problem) => problem.path === requiredPath)
    ) {
      problems.push({ path: `names.${locales.required}`, code: 'required' });
    }
    const seen = new Set<string>();
    for (const entry of names) {
      const key = entry.name.toLowerCase();
      if (seen.has(key)) problems.push({ path: `names.${entry.locale}`, code: 'duplicate' });
      seen.add(key);
    }
  }

  let description: string | null = null;
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') {
      problems.push({ path: 'description', code: 'type' });
    } else {
      const tidy = tidyActivityText(input.description);
      if (tidy.length > ACTIVITY_DESCRIPTION_MAX)
        problems.push({ path: 'description', code: 'too-long' });
      else if (HIDDEN_OR_CONTROL.test(tidy)) problems.push({ path: 'description', code: 'chars' });
      else if (tidy !== '') description = tidy;
    }
  }

  const categoryIds: Id<'Category'>[] = [];
  if (input.categoryIds === undefined) {
    // an absent list is an empty list
  } else if (!Array.isArray(input.categoryIds)) {
    problems.push({ path: 'categoryIds', code: 'type' });
  } else if (input.categoryIds.length > ACTIVITY_CATEGORIES_MAX) {
    problems.push({ path: 'categoryIds', code: 'too-many' });
  } else {
    const seen = new Set<string>();
    input.categoryIds.forEach((id: unknown, index) => {
      if (typeof id !== 'string' || !UUID.test(id)) {
        problems.push({ path: `categoryIds.${index}`, code: 'format' });
      } else if (seen.has(id)) {
        problems.push({ path: `categoryIds.${index}`, code: 'duplicate' });
      } else {
        seen.add(id);
        categoryIds.push(id as Id<'Category'>);
      }
    });
  }

  if (problems.length > 0) return err(problems);
  return ok({ names, description, categoryIds });
}

/** A stored activity as the use cases see it. */
export interface BusinessActivityState {
  readonly id: Id<'BusinessActivity'>;
  readonly code: string;
  readonly status: BusinessActivityStatus;
  readonly description: string | null;
  readonly names: readonly { readonly locale: string; readonly name: string }[];
  readonly categoryIds: readonly Id<'Category'>[];
  readonly createdBy: Id<'Account'>;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

/** The state of a new, active activity at version 1. */
export function newActivity(input: {
  readonly id: Id<'BusinessActivity'>;
  readonly code: string;
  readonly content: BusinessActivityContent;
  readonly createdBy: Id<'Account'>;
  readonly now: Temporal.Instant;
}): BusinessActivityState {
  return {
    id: input.id,
    code: input.code,
    status: 'active',
    description: input.content.description,
    names: input.content.names,
    categoryIds: input.content.categoryIds,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
  };
}
