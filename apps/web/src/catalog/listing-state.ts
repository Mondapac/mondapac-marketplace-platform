// The filter, sort and page state of a product listing. It lives in the URL query so a listing
// can be shared and indexed; every change of a filter or the sort goes back to page 1.

export const SORTS = [
  'recommended',
  'best-seller',
  'price-asc',
  'price-desc',
  'discount',
  'name',
] as const;
export type Sort = (typeof SORTS)[number];

/** The orders the search results offer; "recommended" reads "Best match" there. */
export const SEARCH_SORTS: readonly Sort[] = [
  'recommended',
  'best-seller',
  'price-asc',
  'price-desc',
  'name',
];

export interface ListingFilters {
  readonly special: boolean;
  readonly sameDay: boolean;
  readonly lowStock: boolean;
  /** Certification type codes. */
  readonly certifications: readonly string[];
  /** Seller ids. */
  readonly sellers: readonly string[];
  /** Price band ids. */
  readonly prices: readonly string[];
}

export interface ListingState {
  readonly filters: ListingFilters;
  readonly sort: Sort;
  readonly page: number;
}

export type FilterFlag = 'special' | 'sameDay' | 'lowStock';
export type FilterGroup = 'certifications' | 'sellers' | 'prices';

export const NO_FILTERS: ListingFilters = {
  special: false,
  sameDay: false,
  lowStock: false,
  certifications: [],
  sellers: [],
  prices: [],
};

const FLAG_KEYS: Readonly<Record<FilterFlag, string>> = {
  special: 'special',
  sameDay: 'sameday',
  lowStock: 'low',
};
const GROUP_KEYS: Readonly<Record<FilterGroup, string>> = {
  certifications: 'cert',
  sellers: 'seller',
  prices: 'price',
};
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const MAX_VALUES = 20;
const MAX_PAGE = 100;

type Query = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The ids of a comma-separated value: well-formed ids only, each once, at most 20. */
function idsOf(value: string | string[] | undefined): string[] {
  const ids = (first(value) ?? '').split(',').filter((id) => ID.test(id));
  return [...new Set(ids)].slice(0, MAX_VALUES).sort();
}

export function listingStateOf(query: Query): ListingState {
  const sort = SORTS.find((s) => s === first(query.sort)) ?? 'recommended';
  const pageText = first(query.page);
  const page = pageText !== undefined && /^[0-9]{1,3}$/u.test(pageText) ? Number(pageText) : 1;
  return {
    filters: {
      special: first(query[FLAG_KEYS.special]) === '1',
      sameDay: first(query[FLAG_KEYS.sameDay]) === '1',
      lowStock: first(query[FLAG_KEYS.lowStock]) === '1',
      certifications: idsOf(query[GROUP_KEYS.certifications]),
      sellers: idsOf(query[GROUP_KEYS.sellers]),
      prices: idsOf(query[GROUP_KEYS.prices]),
    },
    sort,
    page: page >= 1 && page <= MAX_PAGE ? page : 1,
  };
}

/**
 * The listing's URL for a state, with the query keys in one order and defaults left out. A query
 * already on `path` (the search words of the results page) stays first.
 */
export function listingHref(path: string, state: ListingState): string {
  const [base = path, fixed] = path.split('?', 2);
  const params = new URLSearchParams(fixed);
  const { filters } = state;
  for (const flag of Object.keys(FLAG_KEYS) as FilterFlag[])
    if (filters[flag]) params.set(FLAG_KEYS[flag], '1');
  for (const group of Object.keys(GROUP_KEYS) as FilterGroup[])
    if (filters[group].length > 0)
      params.set(GROUP_KEYS[group], [...filters[group]].sort().join(','));
  if (state.sort !== 'recommended') params.set('sort', state.sort);
  if (state.page > 1) params.set('page', String(state.page));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function activeFilterCount(filters: ListingFilters): number {
  return (
    Number(filters.special) +
    Number(filters.sameDay) +
    Number(filters.lowStock) +
    filters.certifications.length +
    filters.sellers.length +
    filters.prices.length
  );
}

/** The state with one filter flag set or cleared, on page 1. */
export function withFlag(state: ListingState, flag: FilterFlag, on: boolean): ListingState {
  return { ...state, filters: { ...state.filters, [flag]: on }, page: 1 };
}

/** The state with one id added to or removed from a filter group, on page 1. */
export function withValue(
  state: ListingState,
  group: FilterGroup,
  id: string,
  on: boolean,
): ListingState {
  const rest = state.filters[group].filter((v) => v !== id);
  return {
    ...state,
    filters: { ...state.filters, [group]: on ? [...rest, id].sort() : rest },
    page: 1,
  };
}

export function withoutFilters(state: ListingState): ListingState {
  return { ...state, filters: NO_FILTERS, page: 1 };
}

export function withSort(state: ListingState, sort: Sort): ListingState {
  return { ...state, sort, page: 1 };
}

export function withPage(state: ListingState, page: number): ListingState {
  return { ...state, page };
}
