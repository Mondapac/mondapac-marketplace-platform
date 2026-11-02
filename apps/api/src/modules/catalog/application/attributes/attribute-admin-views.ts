import { ATTRIBUTE_DATA_TYPES, ok, parseId } from '@mondapac/shared-kernel';
import type { AttributeDataType, Id, Result } from '@mondapac/shared-kernel';
import type { AttributeBounds, LocalizedText } from '../../domain/attribute-definition';
import { invalid, type ValidationFailure } from '../brands/brand-views';
import type {
  AttributeDefinitionRecord,
  AttributeRevisionRecord,
  FeatureSetRecord,
} from '../ports/attribute-admin.reader';

/** The default and largest page of the admin attribute list. */
export const ATTRIBUTE_PAGE_DEFAULT = 25;
export const ATTRIBUTE_PAGE_MAX = 100;
/** The longest search text of the admin list. */
export const ATTRIBUTE_SEARCH_MAX = 120;
/**
 * The most definitions and families one Market's admin reads load. The plan expects tens of
 * attributes per Market (plan 16: 24); the list filters and pages in memory below this bound, and
 * the answer says when the bound was reached so it is never silently partial.
 */
export const ATTRIBUTE_LOAD_MAX = 2000;
export const FEATURE_SET_LOAD_MAX = 500;
/** The newest revisions the History tab shows. */
export const ATTRIBUTE_HISTORY_MAX = 100;

/** The statuses a definition can have; `draft` arrives with package A2 (decision 11). */
export const ATTRIBUTE_STATUS_FILTERS = ['draft', 'active', 'archived'] as const;
export type AttributeStatusFilter = (typeof ATTRIBUTE_STATUS_FILTERS)[number];

export interface MarketLocales {
  readonly default: string;
  readonly supported: readonly string[];
}

/** The Market's locales with the default first, as every admin read answers them. */
export function marketLocalesOf(policy: {
  readonly default: string;
  readonly supported: readonly string[];
}): MarketLocales {
  return {
    default: policy.default,
    supported: [policy.default, ...policy.supported.filter((l) => l !== policy.default)],
  };
}

export interface AttributeListFilter {
  readonly search: string | null;
  readonly dataType: AttributeDataType | null;
  readonly status: AttributeStatusFilter | null;
  readonly usedIn: Id<'AttributeFamily'> | null;
  readonly missing: string | null;
}

/** Where a definition sits in a family: one entry per family that names its code. */
export interface FeatureSetUse {
  readonly featureSetId: string;
  readonly featureSetCode: string;
  readonly featureSetStatus: string;
  readonly groupCode: string;
  readonly required: boolean;
  readonly isVariantOption: boolean;
}

/** One change between two revisions of a definition: a field, and its value before and after. */
export interface AttributeChange {
  /** `name.{locale}`, `material`, `isVariantOption`, `bounds.{key}` or `option.{code}.{part}`. */
  readonly field: string;
  readonly before: string | number | boolean | null;
  readonly after: string | number | boolean | null;
}

export function attributeIdOf(raw: unknown): Id<'AttributeDefinition'> | null {
  const parsed = typeof raw === 'string' ? parseId<'AttributeDefinition'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

export function featureSetIdOf(raw: unknown): Id<'AttributeFamily'> | null {
  const parsed = typeof raw === 'string' ? parseId<'AttributeFamily'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/** The filters of the list from the query: each one optional, each one closed. */
export function listFilterOf(
  input: Record<string, unknown>,
  locales: MarketLocales,
): Result<AttributeListFilter, ValidationFailure> {
  const present = (key: string): unknown =>
    input[key] === undefined || input[key] === null || input[key] === '' ? undefined : input[key];
  let search: string | null = null;
  const rawSearch = present('search');
  if (rawSearch !== undefined) {
    if (typeof rawSearch !== 'string') return invalid('search', 'type');
    const tidy = rawSearch.trim();
    if ([...tidy].length > ATTRIBUTE_SEARCH_MAX) return invalid('search', 'too-long');
    search = tidy === '' ? null : tidy;
  }
  const rawType = present('type');
  if (
    rawType !== undefined &&
    (typeof rawType !== 'string' || !(ATTRIBUTE_DATA_TYPES as readonly string[]).includes(rawType))
  ) {
    return invalid('type', 'unknown');
  }
  const rawStatus = present('status');
  if (
    rawStatus !== undefined &&
    (typeof rawStatus !== 'string' ||
      !(ATTRIBUTE_STATUS_FILTERS as readonly string[]).includes(rawStatus))
  ) {
    return invalid('status', 'unknown');
  }
  let usedIn: Id<'AttributeFamily'> | null = null;
  const rawUsedIn = present('usedIn');
  if (rawUsedIn !== undefined) {
    usedIn = featureSetIdOf(rawUsedIn);
    if (usedIn === null) return invalid('usedIn', 'format');
  }
  const rawMissing = present('missing');
  if (
    rawMissing !== undefined &&
    (typeof rawMissing !== 'string' || !locales.supported.includes(rawMissing))
  ) {
    return invalid('missing', 'unknown');
  }
  return ok({
    search,
    dataType: (rawType ?? null) as AttributeDataType | null,
    status: (rawStatus ?? null) as AttributeStatusFilter | null,
    usedIn,
    missing: rawMissing ?? null,
  });
}

/**
 * The Market locales a definition has no text in: its name, or the label of one of its active
 * options. Plan 8: every language is entered by hand, so a locale without text is "Missing".
 */
export function missingLocalesOf(
  revision: Pick<AttributeRevisionRecord, 'names' | 'options'>,
  locales: MarketLocales,
): readonly string[] {
  const has = (text: LocalizedText, locale: string): boolean =>
    typeof text[locale] === 'string' && text[locale] !== '';
  return locales.supported.filter(
    (locale) =>
      !has(revision.names, locale) ||
      revision.options.some((option) => option.active && !has(option.labels, locale)),
  );
}

/** Every place a family's published revision names this code. */
export function usesOf(
  code: string,
  featureSets: readonly FeatureSetRecord[],
): readonly FeatureSetUse[] {
  const uses: FeatureSetUse[] = [];
  for (const set of featureSets) {
    for (const group of set.groups) {
      for (const entry of group.attributes) {
        if (entry.code !== code) continue;
        uses.push({
          featureSetId: set.id,
          featureSetCode: set.code,
          featureSetStatus: set.status,
          groupCode: group.groupCode,
          required: entry.required,
          isVariantOption: entry.isVariantOption,
        });
      }
    }
  }
  return uses;
}

/** Case-insensitive, accent-tolerant match of a search text inside a code or a name. */
const fold = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');

/** Whether a definition passes every filter of the list. */
export function matchesFilter(
  definition: AttributeDefinitionRecord,
  filter: AttributeListFilter,
  featureSets: readonly FeatureSetRecord[],
  locales: MarketLocales,
): boolean {
  if (filter.dataType !== null && definition.dataType !== filter.dataType) return false;
  if (filter.status !== null && definition.status !== filter.status) return false;
  if (filter.usedIn !== null) {
    const set = featureSets.find((candidate) => candidate.id === filter.usedIn);
    if (set === undefined) return false;
    if (usesOf(definition.code, [set]).length === 0) return false;
  }
  if (
    filter.missing !== null &&
    !missingLocalesOf(definition.revision, locales).includes(filter.missing)
  ) {
    return false;
  }
  if (filter.search !== null) {
    const needle = fold(filter.search);
    const haystack = [definition.code, ...Object.values(definition.revision.names)];
    if (!haystack.some((text) => fold(text).includes(needle))) return false;
  }
  return true;
}

/**
 * One page after the definition with id `afterId` in the order given (by code). An `afterId`
 * that is not in the list answers an empty last page, as the brand list does for a lost cursor.
 */
export function pageOf<T extends { readonly id: string }>(
  rows: readonly T[],
  afterId: string | null,
  limit: number,
): { readonly items: readonly T[]; readonly nextAfterId: string | null } {
  let start = 0;
  if (afterId !== null) {
    const index = rows.findIndex((row) => row.id === afterId);
    if (index < 0) return { items: [], nextAfterId: null };
    start = index + 1;
  }
  const items = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  return { items, nextAfterId: more ? items[items.length - 1]!.id : null };
}

const scalar = (value: unknown): string | number | boolean | null =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null;

const BOUND_KEYS: readonly (keyof AttributeBounds)[] = ['maxLength', 'min', 'max'];

/**
 * The field-by-field difference between two revisions (plan 15: who, when, what). The first
 * revision of a definition has no `before`: its changes are empty and the History tab shows it as
 * "Created". Options are compared by code: added, label per locale, active and position.
 */
export function changesBetween(
  before: AttributeRevisionRecord,
  after: AttributeRevisionRecord,
): readonly AttributeChange[] {
  const changes: AttributeChange[] = [];
  const push = (field: string, a: unknown, b: unknown) => {
    const left = scalar(a);
    const right = scalar(b);
    if (left !== right) changes.push({ field, before: left, after: right });
  };
  const localeKeys = (x: LocalizedText, y: LocalizedText) =>
    [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
  for (const locale of localeKeys(before.names, after.names)) {
    push(`name.${locale}`, before.names[locale], after.names[locale]);
  }
  push('material', before.material, after.material);
  push('isVariantOption', before.isVariantOption, after.isVariantOption);
  for (const key of BOUND_KEYS) push(`bounds.${key}`, before.bounds[key], after.bounds[key]);
  const old = new Map(before.options.map((option) => [option.code, option]));
  for (const option of after.options) {
    const previous = old.get(option.code);
    if (previous === undefined) {
      changes.push({ field: `option.${option.code}.added`, before: null, after: true });
      continue;
    }
    for (const locale of localeKeys(previous.labels, option.labels)) {
      push(`option.${option.code}.label.${locale}`, previous.labels[locale], option.labels[locale]);
    }
    push(`option.${option.code}.active`, previous.active, option.active);
    push(`option.${option.code}.position`, previous.position, option.position);
  }
  return changes;
}

/** The fields of a definition every admin read shows. */
export interface AttributeSummaryView {
  readonly id: string;
  readonly code: string;
  readonly dataType: AttributeDataType;
  readonly localizable: boolean;
  readonly status: string;
  readonly names: LocalizedText;
  readonly material: boolean;
  readonly isVariantOption: boolean;
  readonly revisionNo: number;
  readonly missingLocales: readonly string[];
}

export function summaryOf(
  definition: AttributeDefinitionRecord,
  locales: MarketLocales,
): AttributeSummaryView {
  return {
    id: definition.id,
    code: definition.code,
    dataType: definition.dataType,
    localizable: definition.localizable,
    status: definition.status,
    names: { ...definition.revision.names },
    material: definition.revision.material,
    isVariantOption: definition.revision.isVariantOption,
    revisionNo: definition.revision.revisionNo,
    missingLocales: missingLocalesOf(definition.revision, locales),
  };
}
