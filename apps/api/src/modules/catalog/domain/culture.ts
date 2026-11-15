import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';
import { isTagTypeCode } from './offer-tag';

// The culture entity (multi-culture package 1; ADR-0047). A culture is a community and the product
// standard that goes with it. An admin defines it per Market; core code never names one
// (ADR-0001 decision 5): the code is data.
//
//   draft ---> active <---> inactive
//
// The code is fixed at creation. At most one culture of a Market is the default; it is always
// active and cannot be made inactive. A culture is never deleted here (no delete route): once a
// later package links sellers to it, it can only be made inactive.

export const CULTURE_STATUSES = ['draft', 'active', 'inactive'] as const;
export type CultureStatus = (typeof CULTURE_STATUSES)[number];

export const CULTURE_CODE_MAX = 40;
export const CULTURE_NAME_MAX = 80;
export const CULTURE_DESCRIPTION_MAX = 300;
export const CULTURE_DISPLAY_ORDER_MAX = 9999;
/** The most cultures one Market may define. */
export const CULTURES_PER_MARKET_MAX = 200;

const CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** A design-token name for the badge colour, never a raw colour value. */
const BADGE_COLOUR_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Control, format and separator characters other than a plain space: never part of a text. */
const HIDDEN_OR_CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;

export const isCultureCode = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= CULTURE_CODE_MAX && CODE_PATTERN.test(value);

export const isBadgeColour = (value: unknown): value is string =>
  typeof value === 'string' && BADGE_COLOUR_PATTERN.test(value);

/** Inner runs of whitespace become one space and the ends are trimmed. */
export const tidyCultureText = (raw: string): string => raw.replace(/\s+/gu, ' ').trim();

export interface CultureFieldProblem {
  readonly path: string;
  readonly code: string;
}

/** The name and short description of a culture in one locale. */
export interface CultureName {
  readonly locale: string;
  readonly name: string;
  readonly description: string | null;
}

/**
 * A locale is published only when all its fields exist (ADR-0047 decision 1): a name and a
 * description. A half-written locale is stored but never shown, and never machine-translated.
 */
export const isCultureNamePublished = (entry: CultureName): boolean => entry.description !== null;

export interface CultureContent {
  readonly names: readonly CultureName[];
}

export interface CultureLocales {
  /** The locale whose name and description are required (English). */
  readonly required: string;
  readonly supported: readonly string[];
}

/**
 * Validates the names of a create or an edit: an object of locale to `{ name, description }`. The
 * required locale must have both fields; any other locale needs at least a name; every locale must
 * be supported; a name is 1 to 80 and a description 1 to 300 characters without control
 * characters. A locale with neither field is the same as no entry. All problems come back together.
 */
export function parseCultureContent(
  input: { readonly names?: unknown },
  locales: CultureLocales,
): Result<CultureContent, readonly CultureFieldProblem[]> {
  const problems: CultureFieldProblem[] = [];
  const names: CultureName[] = [];
  const rawNames = input.names;
  if (typeof rawNames !== 'object' || rawNames === null || Array.isArray(rawNames)) {
    return err([{ path: 'names', code: 'type' }]);
  }
  for (const locale of Object.keys(rawNames).sort()) {
    const path = `names.${locale.slice(0, 16)}`;
    if (!LOCALE_PATTERN.test(locale) || !locales.supported.includes(locale)) {
      problems.push({ path, code: 'locale-unsupported' });
      continue;
    }
    const raw: unknown = (rawNames as Record<string, unknown>)[locale];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      problems.push({ path, code: 'type' });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    let bad = false;
    for (const key of Object.keys(entry)) {
      if (key !== 'name' && key !== 'description') {
        problems.push({ path: `${path}.${key.slice(0, 32)}`, code: 'unknown' });
        bad = true;
      }
    }
    const name = tidyField(entry['name'], `${path}.name`, CULTURE_NAME_MAX, problems);
    const description = tidyField(
      entry['description'],
      `${path}.description`,
      CULTURE_DESCRIPTION_MAX,
      problems,
    );
    if (bad || name === undefined || description === undefined) continue;
    if (name === null && description === null) continue; // the same as no entry
    if (name === null) {
      problems.push({ path: `${path}.name`, code: 'required' });
      continue;
    }
    names.push({ locale, name, description });
  }
  const requiredPath = `names.${locales.required}`;
  const required = names.find((entry) => entry.locale === locales.required);
  if (required === undefined) {
    if (!problems.some((problem) => problem.path.startsWith(requiredPath))) {
      problems.push({ path: `${requiredPath}.name`, code: 'required' });
    }
  } else if (required.description === null) {
    problems.push({ path: `${requiredPath}.description`, code: 'required' });
  }
  if (problems.length > 0) return err(problems);
  return ok({ names });
}

/** A tidy text, null when empty or absent, undefined when a problem was recorded. */
function tidyField(
  raw: unknown,
  path: string,
  max: number,
  problems: CultureFieldProblem[],
): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    problems.push({ path, code: 'type' });
    return undefined;
  }
  const tidy = tidyCultureText(raw);
  if (tidy === '') return null;
  if (tidy.length > max) {
    problems.push({ path, code: 'too-long' });
    return undefined;
  }
  if (HIDDEN_OR_CONTROL.test(tidy)) {
    problems.push({ path, code: 'chars' });
    return undefined;
  }
  return tidy;
}

/** A stored culture as the use cases see it. */
export interface CultureState {
  readonly id: Id<'Culture'>;
  readonly code: string;
  readonly status: CultureStatus;
  readonly displayOrder: number;
  /** A certification type code of the Market, or null; a plain string (no cross-schema key). */
  readonly requiredCertificationType: string | null;
  readonly badgeColour: string | null;
  readonly isDefault: boolean;
  readonly names: readonly CultureName[];
  readonly createdBy: Id<'Account'> | null;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

export function parseDisplayOrder(raw: unknown): Result<number, CultureFieldProblem> {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return err({ path: 'displayOrder', code: 'type' });
  }
  if (raw < 0 || raw > CULTURE_DISPLAY_ORDER_MAX)
    return err({ path: 'displayOrder', code: 'range' });
  return ok(raw);
}

export function parseBadgeColour(raw: unknown): Result<string | null, CultureFieldProblem> {
  if (raw === null) return ok(null);
  return isBadgeColour(raw) ? ok(raw) : err({ path: 'badgeColour', code: 'format' });
}

export function parseRequiredCertificationType(
  raw: unknown,
): Result<string | null, CultureFieldProblem> {
  if (raw === null) return ok(null);
  return isTagTypeCode(raw) ? ok(raw) : err({ path: 'requiredCertificationType', code: 'format' });
}

/** The state of a new culture: a draft at version 1, never the default (a later edit sets that). */
export function newCulture(input: {
  readonly id: Id<'Culture'>;
  readonly code: string;
  readonly content: CultureContent;
  readonly displayOrder: number;
  readonly requiredCertificationType: string | null;
  readonly badgeColour: string | null;
  readonly createdBy: Id<'Account'> | null;
  readonly now: Temporal.Instant;
}): CultureState {
  return {
    id: input.id,
    code: input.code,
    status: 'draft',
    displayOrder: input.displayOrder,
    requiredCertificationType: input.requiredCertificationType,
    badgeColour: input.badgeColour,
    isDefault: false,
    names: input.content.names,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
  };
}

/** Why an edit of a culture is refused by a domain rule. */
export type CultureRefusal =
  | 'culture.status-transition'
  | 'culture.default-must-stay-active'
  | 'culture.default-must-be-active'
  | 'culture.default-required';

/** What an edit may change. A field left out stays as it is; `null` clears a nullable field. */
export interface CultureChange {
  readonly names?: readonly CultureName[];
  readonly displayOrder?: number;
  readonly status?: CultureStatus;
  readonly badgeColour?: string | null;
  readonly requiredCertificationType?: string | null;
  /** `true` makes this the Market's default; `false` is refused on the default itself. */
  readonly isDefault?: boolean;
}

/** The moves between statuses: a culture never goes back to draft once it has been active. */
const STATUS_MOVES: Readonly<Record<CultureStatus, readonly CultureStatus[]>> = {
  draft: ['active'],
  active: ['inactive'],
  inactive: ['active'],
};

/**
 * Applies an edit (pure). The code never changes. Rules: the status follows {@link STATUS_MOVES};
 * the default culture is always active (so it cannot be made inactive or drafted) and cannot be
 * un-marked directly (another culture is made the default instead); only an active culture can be
 * made the default.
 */
export function editCulture(
  state: CultureState,
  change: CultureChange,
  now: Temporal.Instant,
): Result<CultureState, CultureRefusal> {
  const status = change.status ?? state.status;
  if (status !== state.status && !STATUS_MOVES[state.status].includes(status)) {
    return err('culture.status-transition');
  }
  if (change.isDefault === false && state.isDefault) return err('culture.default-required');
  const isDefault = change.isDefault === true ? true : state.isDefault;
  if (isDefault && status !== 'active') {
    return err(
      state.isDefault ? 'culture.default-must-stay-active' : 'culture.default-must-be-active',
    );
  }
  return ok({
    ...state,
    status,
    isDefault,
    names: change.names ?? state.names,
    displayOrder: change.displayOrder ?? state.displayOrder,
    badgeColour: change.badgeColour === undefined ? state.badgeColour : change.badgeColour,
    requiredCertificationType:
      change.requiredCertificationType === undefined
        ? state.requiredCertificationType
        : change.requiredCertificationType,
    updatedAt: now,
    version: state.version + 1,
  });
}
