import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  isChangeValues,
  type ChangeValues,
  type RecordedRequest,
  type RecordFailure,
  type Risk,
  type SystemRequestRecorder,
} from '../../system-requests';
import type { AttributeBounds, AttributeDefinitionState } from '../domain/attribute-definition';
import type { CategorySeo, CategoryText } from '../domain/category-edit';

// Admin Inbox › System requests, area catalogue: an admin's edits of the platform catalogue
// structure go live at once and are reviewed after (owner decision of 15 Nov 2026). Only field
// edits that can be put back are reviewed: the details of a platform category, the content of an
// attribute definition, and the feature set and filters a category holds. Create, delete, merge,
// move, import and everything seller-scoped are not. A rejected or withdrawn edit is restored by
// the reverters in catalogue-reverters.ts, as one more revision.

/** The review area of catalog's structure edits. */
export const CATALOGUE_REVIEW_AREA = 'catalogue';
/** The details of a platform category; subject = the category id. */
export const CATEGORY_DETAILS_SUBJECT_KIND = 'catalog.category-details';
/** The content of an attribute definition; subject = the definition id. */
export const ATTRIBUTE_DEFINITION_SUBJECT_KIND = 'catalog.attribute-definition';
/** The feature set and filters of a category; subject = the category id. */
export const CATEGORY_LINKS_SUBJECT_KIND = 'catalog.category-attribute-links';

/** Whether an edit of the catalogue structure is reviewed in the Market (the page then asks for a note). */
export interface CatalogueReview {
  readonly reviewed: boolean;
  readonly risk: Risk;
}

/** The review request an edit opened (null when none), as an answer carries it. */
export type CatalogueRequestRef = Pick<RecordedRequest, 'id' | 'number'> | null;

export const requestRef = (request: RecordedRequest | null): CatalogueRequestRef =>
  request === null ? null : { id: request.id, number: request.number };

/**
 * The review policy of area catalogue, for the page (the area's default on a failure). It opens a
 * read-only unit of its own, so call it outside any unit.
 */
export async function catalogueReview(
  review: Pick<SystemRequestRecorder, 'areaPolicy'>,
  context: CallContext,
): Promise<CatalogueReview> {
  const policy = await review.areaPolicy(context, CATALOGUE_REVIEW_AREA);
  return { reviewed: policy.enabled, risk: policy.risk };
}

/**
 * Opens the review of an edit that is already written, in the caller's open unit. The values must
 * fit a request (10 KB, three levels): the recorder refuses others by throwing, which must never
 * reach an admin as a server error. So an edit whose values do not fit is refused with
 * `validation.failed` on `tooLargePath` (nothing is kept) where the Market reviews the area, and
 * simply not reviewed where it does not. `policy` is the one read before the unit opened.
 */
export async function openCatalogueReview(
  review: Pick<SystemRequestRecorder, 'openReview'>,
  context: CallContext,
  policy: CatalogueReview,
  change: {
    readonly subjectKind: string;
    readonly subjectRef: string;
    readonly before: ChangeValues;
    readonly after: ChangeValues;
    readonly note: unknown;
    /** The field to blame when the values do not fit. */
    readonly tooLargePath: string;
  },
): Promise<Result<RecordedRequest | null, RecordFailure>> {
  if (!isChangeValues(change.before) || !isChangeValues(change.after)) {
    return policy.reviewed
      ? err({
          code: 'validation.failed',
          fields: [{ path: change.tooLargePath, code: 'too-large-for-review' }],
        })
      : ok(null);
  }
  return review.openReview(context, {
    area: CATALOGUE_REVIEW_AREA,
    subjectKind: change.subjectKind,
    subjectRef: change.subjectRef,
    before: change.before,
    after: change.after,
    note: change.note,
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const byLocale = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- category details ------------------------------------------------------------------------

/**
 * The details of a category as the values of a request, the whole content the revert needs.
 * Per-locale fields are objects keyed by locale (a request keeps three levels): keywords sit at
 * the second level, where a list may still be kept.
 */
export function categoryDetailsValues(
  texts: readonly CategoryText[],
  seo: CategorySeo,
  showInMenu: boolean,
): ChangeValues {
  const sorted = [...texts].sort((a, b) => byLocale(a.locale, b.locale));
  return {
    names: Object.fromEntries(sorted.map((text) => [text.locale, text.name])),
    shortDescriptions: Object.fromEntries(
      sorted.map((text) => [text.locale, text.shortDescription]),
    ),
    keywords: Object.fromEntries(sorted.map((text) => [text.locale, [...text.keywords]])),
    seoTitle: seo.title,
    seoDescription: seo.description,
    noindex: seo.noindex,
    showInMenu,
  };
}

export interface CategoryDetailsValues {
  readonly texts: readonly CategoryText[];
  readonly seo: CategorySeo;
  readonly showInMenu: boolean;
}

/** The details a request's values hold; null when they are not category details (not ours). */
export function categoryDetailsOf(values: unknown): CategoryDetailsValues | null {
  if (!isRecord(values)) return null;
  const { names, shortDescriptions, keywords, seoTitle, seoDescription, noindex, showInMenu } =
    values;
  if (!isRecord(names) || !isRecord(shortDescriptions) || !isRecord(keywords)) return null;
  if (typeof noindex !== 'boolean' || typeof showInMenu !== 'boolean') return null;
  if (
    (seoTitle !== null && typeof seoTitle !== 'string') ||
    (seoDescription !== null && typeof seoDescription !== 'string')
  ) {
    return null;
  }
  const texts: CategoryText[] = [];
  for (const [locale, name] of Object.entries(names).sort(([a], [b]) => byLocale(a, b))) {
    const description = shortDescriptions[locale];
    const words = keywords[locale];
    if (
      typeof name !== 'string' ||
      (description !== null && typeof description !== 'string') ||
      !Array.isArray(words) ||
      !words.every((word) => typeof word === 'string')
    ) {
      return null;
    }
    texts.push({
      locale,
      name,
      shortDescription: description ?? null,
      keywords: words,
    });
  }
  return {
    texts,
    seo: { title: seoTitle ?? null, description: seoDescription ?? null, noindex },
    showInMenu,
  };
}

// ---- attribute definition --------------------------------------------------------------------

function measureValues(bounds: AttributeBounds): ChangeValues {
  const measure = bounds.measure;
  return {
    measureDimension: measure?.dimension ?? null,
    measureUnits: measure === undefined ? [] : [...measure.units],
    measureDefaultUnit: measure?.defaultUnit ?? null,
    measureDecimals: measure?.decimals ?? null,
  };
}

/**
 * What a reviewer reads of an attribute definition: its names and flags, the shape of its bounds
 * and the counts of its values. `revisionNo` names the revision the revert writes back (every
 * earlier revision stays readable) and `version` is what a later change is compared with.
 */
export function attributeValues(state: AttributeDefinitionState): ChangeValues {
  const { bounds } = state;
  return {
    revisionNo: state.revisionNo,
    version: state.version,
    status: state.status,
    names: { ...state.names },
    helpText: { ...state.display.helpText },
    material: state.material,
    isVariantOption: state.isVariantOption,
    showOnProductPage: state.display.showOnProductPage,
    searchable: state.display.searchable,
    canBeFilter: state.display.canBeFilter,
    position: state.display.position,
    maxLength: bounds.maxLength ?? null,
    min: bounds.min ?? null,
    max: bounds.max ?? null,
    ...measureValues(bounds),
    optionCount: state.options.length,
    activeOptionCount: state.options.filter((option) => option.active).length,
  };
}

const sortedEntries = (map: Readonly<Record<string, string>>): [string, string][] =>
  Object.entries(map).sort(([a], [b]) => byLocale(a, b));

/** The content of a definition that an edit may change, to tell a real change from a no-op save. */
export function attributeContent(state: AttributeDefinitionState): string {
  return JSON.stringify({
    names: sortedEntries(state.names),
    material: state.material,
    isVariantOption: state.isVariantOption,
    bounds: state.bounds,
    options: state.options.map((option) => ({
      code: option.code,
      labels: sortedEntries(option.labels),
      active: option.active,
      position: option.position,
    })),
    display: {
      ...state.display,
      helpText: sortedEntries(state.display.helpText),
    },
  });
}

// ---- category attribute links ----------------------------------------------------------------

/** The feature set (null: the parent's) and the filter codes in order. */
export interface CategoryLinksValues {
  readonly featureSetId: string | null;
  readonly filters: readonly string[];
}

export const linksValues = (links: CategoryLinksValues): ChangeValues => ({
  featureSetId: links.featureSetId,
  filters: [...links.filters],
});

/** The links a request's values hold; null when they are not category links (not ours). */
export function linksOf(values: unknown): CategoryLinksValues | null {
  if (!isRecord(values)) return null;
  const { featureSetId, filters } = values;
  if (featureSetId !== null && typeof featureSetId !== 'string') return null;
  if (!Array.isArray(filters) || !filters.every((code) => typeof code === 'string')) return null;
  return { featureSetId: featureSetId ?? null, filters: filters };
}

// ---- shared ----------------------------------------------------------------------------------

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => byLocale(a, b)))
      : inner,
  );

/** Two sets of values say the same thing (the order of fields does not matter; lists keep theirs). */
export const sameContent = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/**
 * A recorder that reviews nothing, for the file imports (owner decision of 15 Nov 2026: import is
 * not reviewed). An import runs the same editor use cases as the panel, with this in place of the
 * real recorder, so it needs no note and opens no request.
 */
export const NO_REVIEW: SystemRequestRecorder = {
  areaPolicy: () => Promise.resolve({ enabled: false, risk: 'low' }),
  openReview: () => Promise.resolve(ok(null)),
};
