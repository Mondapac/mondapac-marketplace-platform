// The "Attribute links" tab of a category (categories C8, built inside attributes A4): the
// answers of the two category-links routes and the pure rules the editor follows. Names are text
// an admin entered: rendered as plain text only.

export const VIEW_ATTRIBUTES_PERMISSION = 'catalog.attribute.view';
export const EDIT_ATTRIBUTES_PERMISSION = 'catalog.attribute.edit';
export const LINKS_SUFFIX = 'attribute-links';
export const API_FEATURE_SETS = 'catalog/admin/feature-sets';
export const API_ATTRIBUTES = 'catalog/admin/attributes';

/** What the person may do with attribute links: nothing, read them, or change them. */
export type AttributeAccess = 'none' | 'view' | 'edit';

/** The data types a buyer can filter by (the API's own list; decision ت۸). */
export const FILTERABLE_TYPES: ReadonlySet<string> = new Set([
  'select',
  'multi-select',
  'boolean',
  'integer',
  'decimal',
]);

/** The most filters one category lists itself (the API and the database say the same). */
export const MAX_OWN_FILTERS = 20;

export type Localized = Readonly<Record<string, string>>;

export interface LinksFeatureSet {
  readonly id: string;
  readonly code: string;
  readonly names: Localized;
  readonly fromCategoryId: string;
  readonly inherited: boolean;
}

export interface LinksFilter {
  readonly code: string;
  readonly fromCategoryId: string;
  readonly inherited: boolean;
  readonly names: Localized | null;
  readonly dataType: string | null;
  readonly status: string | null;
}

export interface LinksBody {
  readonly categoryId: string;
  /** What the category holds itself; null when nobody has set it. */
  readonly own: {
    readonly featureSetId: string | null;
    readonly filters: readonly string[];
    readonly revisionNo: number;
    readonly version: number;
  } | null;
  readonly effective: {
    readonly featureSet: LinksFeatureSet | null;
    readonly filters: readonly LinksFilter[];
  };
}

export interface FeatureSetOption {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly names: Localized;
}

export interface AttributeOption {
  readonly code: string;
  readonly dataType: string;
  readonly status: string;
  readonly names: Localized;
}

/** The name in the Market's default locale, else the first one, else the code. */
export function labelOf(names: Localized | null, locale: string, code: string): string {
  if (names === null) return code;
  const own = names[locale];
  if (own !== undefined && own !== '') return own;
  const first = Object.values(names).find((value) => value !== '');
  return first ?? code;
}

/** What the editor holds: the feature set choice and the category's own filters, in order. */
export interface LinksDraft {
  /** `null`: the category takes its parent's feature set. */
  readonly featureSetId: string | null;
  readonly filters: readonly string[];
}

export function draftOf(body: LinksBody): LinksDraft {
  return { featureSetId: body.own?.featureSetId ?? null, filters: [...(body.own?.filters ?? [])] };
}

export function sameDraft(a: LinksDraft, b: LinksDraft): boolean {
  return (
    a.featureSetId === b.featureSetId &&
    a.filters.length === b.filters.length &&
    a.filters.every((code, index) => code === b.filters[index])
  );
}

/** Moves the filter at `index` one place; out of range leaves the list as it is. */
export function moveFilter(
  filters: readonly string[],
  index: number,
  by: -1 | 1,
): readonly string[] {
  const target = index + by;
  if (index < 0 || index >= filters.length || target < 0 || target >= filters.length) {
    return filters;
  }
  const next = [...filters];
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

/**
 * The attributes the "Add a filter" select offers: active, of a filterable type, and not listed
 * yet by this category or an ancestor. Whether an attribute may be a filter at all is the
 * attribute's own setting; the API refuses one that may not.
 */
export function filterChoices(
  attributes: readonly AttributeOption[],
  taken: ReadonlySet<string>,
): readonly AttributeOption[] {
  return attributes.filter(
    (attribute) =>
      attribute.status === 'active' &&
      FILTERABLE_TYPES.has(attribute.dataType) &&
      !taken.has(attribute.code),
  );
}

/** The key of the message that explains a refused save. */
export function linksErrorKey(status: number, code: string): string {
  switch (code) {
    case 'category-links.stale':
      return 'stale';
    case 'category-links.feature-set-unknown':
    case 'category-links.feature-set-not-active':
      return 'feature-set';
    case 'category-links.filter-unknown':
    case 'category-links.filter-invalid':
      return 'filter-unknown';
    case 'category-links.filter-not-filterable':
      return 'filter-not-filterable';
    case 'category-links.filter-repeated':
      return 'filter-repeated';
    case 'category-links.too-many-filters':
      return 'too-many';
    case 'category.not-active':
      return 'not-active';
    case 'category.not-found':
      return 'not-found';
    case 'access.denied':
    case 'request.csrf':
      return 'denied';
    default:
      return status === 0 ? 'network' : 'unknown';
  }
}
