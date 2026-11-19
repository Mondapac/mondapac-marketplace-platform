import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  isChangeValues,
  type ChangeValues,
  type ProposeFailure,
  type RecordedRequest,
  type RecordFailure,
  type Risk,
  type SystemActionProposer,
  type SystemRequestRecorder,
} from '../../system-requests';
import type { AttributeBounds, AttributeDefinitionState } from '../domain/attribute-definition';
import type { CategorySeo, CategoryText } from '../domain/category-edit';

// Admin Inbox › System requests, area catalogue: an admin's edits of the platform catalogue
// structure go live at once and are reviewed after (owner decision of 15 Nov 2026): the details of
// a platform category, the content of an attribute definition, and the feature set and filters a
// category holds. A rejected or withdrawn edit is restored by the reverters in
// catalogue-reverters.ts, as one more revision.
//
// Owner decision of 18 Nov 2026 ("mixed"): a create or a move of the structure also goes live at
// once and is reviewed after (a reject discards or hides the new record, or moves it back:
// catalogue-structure-reverters.ts); a delete, a merge or an archive waits for a second admin's
// approval instead (catalogue-appliers.ts). Imports and everything seller-scoped are not reviewed.

/** The review area of catalog's structure edits. */
export const CATALOGUE_REVIEW_AREA = 'catalogue';
/** The details of a platform category; subject = the category id. */
export const CATEGORY_DETAILS_SUBJECT_KIND = 'catalog.category-details';
/** The content of an attribute definition; subject = the definition id. */
export const ATTRIBUTE_DEFINITION_SUBJECT_KIND = 'catalog.attribute-definition';
/** The feature set and filters of a category; subject = the category id. */
export const CATEGORY_LINKS_SUBJECT_KIND = 'catalog.category-attribute-links';

/** A new platform category (review mode); subject = the category id. */
export const CATEGORY_CREATE_SUBJECT_KIND = 'catalog.category-create';
/** A category moved under another parent (review mode); subject = the category id. */
export const CATEGORY_MOVE_SUBJECT_KIND = 'catalog.category-move';
/** A category moved up or down among its siblings (review mode); subject = the category id. */
export const CATEGORY_REORDER_SUBJECT_KIND = 'catalog.category-reorder';
/** A new attribute definition, a draft (review mode); subject = the definition id. */
export const ATTRIBUTE_CREATE_SUBJECT_KIND = 'catalog.attribute-create';
// Each kind of an action that waits for approval is registered with the one permission key its
// route needs (system-requests checks the approving admin holds it), so actions under different
// keys are different kinds.
/** Discard of a platform category that never went live (approval mode); subject = the id. */
export const CATEGORY_DISCARD_SUBJECT_KIND = 'catalog.category-discard';
/** Merge or archive of a platform category (approval mode); subject = the category id. */
export const CATEGORY_RESTRUCTURE_SUBJECT_KIND = 'catalog.category-restructure';
/** Moving every product of a category to another (approval mode); subject = the source id. */
export const CATEGORY_PRODUCTS_MOVE_SUBJECT_KIND = 'catalog.category-products-move';
/** Discard of a draft attribute definition (approval mode); subject = the definition id. */
export const ATTRIBUTE_DISCARD_SUBJECT_KIND = 'catalog.attribute-discard';
/**
 * Archive (not `material`), merge or merge of values of an attribute definition (approval mode);
 * subject = the definition id.
 */
export const ATTRIBUTE_RESTRUCTURE_SUBJECT_KIND = 'catalog.attribute-restructure';
/**
 * A new feature set (approval mode: a feature set has no delete or archive route, so a create
 * cannot be undone); subject = the code asked for, or the one made from the default-locale name.
 */
export const FEATURE_SET_CREATE_SUBJECT_KIND = 'catalog.feature-set-create';

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
 * What an action that waits for approval answers instead of its usual answer: the proposal it
 * filed (HTTP 202); nothing else was written.
 */
export interface CatalogueProposal {
  readonly request: NonNullable<CatalogueRequestRef>;
}

/** The answer of an action in approval mode: the action done at once, or the proposal filed. */
export type ProposedOr<T> = T | CatalogueProposal;

/** Whether an answer is a proposal (the route answers 202 with it). */
export function isProposal(value: unknown): value is CatalogueProposal {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  const request = (value as { request?: unknown }).request;
  return (
    keys.length === 1 && keys[0] === 'request' && typeof request === 'object' && request !== null
  );
}

/** The note of an action that also takes a reason note: the note when given, else the reason. */
export const noteOr = (note: unknown, reason: string): unknown =>
  note === undefined || note === null ? reason : note;

/**
 * Files an action that waits for another admin's approval, in the caller's open unit, after the
 * caller checked and validated it as it would before applying it. As {@link openCatalogueReview},
 * values that do not fit a request are refused with `too-large-for-review` on `tooLargePath` where
 * the Market reviews the area (and answer null, apply at once, where it does not).
 */
export async function proposeCatalogueAction(
  proposer: Pick<SystemActionProposer, 'proposeChange'>,
  context: CallContext,
  policy: CatalogueReview,
  change: {
    readonly subjectKind: string;
    readonly subjectRef: string;
    readonly before: ChangeValues;
    readonly after: ChangeValues;
    readonly note: unknown;
    readonly tooLargePath: string;
  },
): Promise<Result<RecordedRequest | null, ProposeFailure>> {
  if (!isChangeValues(change.before) || !isChangeValues(change.after)) {
    return policy.reviewed
      ? err({
          code: 'validation.failed',
          fields: [{ path: change.tooLargePath, code: 'too-large-for-review' }],
        })
      : ok(null);
  }
  return proposer.proposeChange(context, {
    area: CATALOGUE_REVIEW_AREA,
    subjectKind: change.subjectKind,
    subjectRef: change.subjectRef,
    before: change.before,
    after: change.after,
    note: change.note,
  });
}

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

/** A proposer that files nothing (the action applies at once), for an import and for tests. */
export const NO_PROPOSAL: SystemActionProposer = {
  proposeChange: () => Promise.resolve(ok(null)),
};
