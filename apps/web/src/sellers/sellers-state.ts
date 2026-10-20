// The filter, sort and "Show more" state of the sellers page. Like the product listing it lives in
// the URL query, so a filtered list can be shared; every change of a filter or the sort goes back
// to the first 12 stores.

/** In the design's order of the Sort select. */
export const SELLER_SORTS = ['popular', 'nearest', 'name', 'newest'] as const;
export type SellerSort = (typeof SELLER_SORTS)[number];

/** The radii of the Distance filter, in kilometres. */
export const DISTANCES = [5, 10, 20] as const;
export type Distance = (typeof DISTANCES)[number];

export interface SellerFilters {
  readonly newSellers: boolean;
  readonly sameDay: boolean;
  /** Certification type codes; a store needs every one. */
  readonly certifications: readonly string[];
  /** Category codes; a store needs any one. */
  readonly categories: readonly string[];
  /** Minimum-order bucket ids; a store needs to fit any one. */
  readonly minimums: readonly string[];
  /** Only when the buyer's location is inside the delivery area. */
  readonly distance?: Distance;
}

export interface SellersState {
  readonly filters: SellerFilters;
  readonly sort: SellerSort;
  /** How many pages of 12 are shown ("Show more" adds one). */
  readonly page: number;
}

export type SellerFlag = 'newSellers' | 'sameDay';
export type SellerGroup = 'certifications' | 'categories' | 'minimums';

export const NO_SELLER_FILTERS: SellerFilters = {
  newSellers: false,
  sameDay: false,
  certifications: [],
  categories: [],
  minimums: [],
};

const FLAG_KEYS: Readonly<Record<SellerFlag, string>> = { newSellers: 'new', sameDay: 'sameday' };
const GROUP_KEYS: Readonly<Record<SellerGroup, string>> = {
  certifications: 'cert',
  categories: 'cat',
  minimums: 'min',
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

/**
 * The state of a query. Distance and the Nearest sort need a location inside the delivery area;
 * without one they are dropped, so moving the location away resets them.
 */
export function sellersStateOf(query: Query, locationInside: boolean): SellersState {
  const sortText = SELLER_SORTS.find((s) => s === first(query.sort)) ?? 'popular';
  const sort = sortText === 'nearest' && !locationInside ? 'popular' : sortText;
  const distance = DISTANCES.find((d) => String(d) === first(query.km));
  const pageText = first(query.page);
  const page = pageText !== undefined && /^[0-9]{1,3}$/u.test(pageText) ? Number(pageText) : 1;
  return {
    filters: {
      newSellers: first(query[FLAG_KEYS.newSellers]) === '1',
      sameDay: first(query[FLAG_KEYS.sameDay]) === '1',
      certifications: idsOf(query[GROUP_KEYS.certifications]),
      categories: idsOf(query[GROUP_KEYS.categories]),
      minimums: idsOf(query[GROUP_KEYS.minimums]),
      ...(distance !== undefined && locationInside ? { distance } : {}),
    },
    sort,
    page: page >= 1 && page <= MAX_PAGE ? page : 1,
  };
}

/** The page's URL for a state, with the query keys in one order and defaults left out. */
export function sellersHref(path: string, state: SellersState): string {
  const params = new URLSearchParams();
  const { filters } = state;
  for (const flag of Object.keys(FLAG_KEYS) as SellerFlag[])
    if (filters[flag]) params.set(FLAG_KEYS[flag], '1');
  for (const group of Object.keys(GROUP_KEYS) as SellerGroup[])
    if (filters[group].length > 0)
      params.set(GROUP_KEYS[group], [...filters[group]].sort().join(','));
  if (filters.distance !== undefined) params.set('km', String(filters.distance));
  if (state.sort !== 'popular') params.set('sort', state.sort);
  if (state.page > 1) params.set('page', String(state.page));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function sellerFilterCount(filters: SellerFilters): number {
  return (
    Number(filters.newSellers) +
    Number(filters.sameDay) +
    filters.certifications.length +
    filters.categories.length +
    filters.minimums.length +
    Number(filters.distance !== undefined)
  );
}

/** The state with one filter flag set or cleared, back to the first 12. */
export function withSellerFlag(state: SellersState, flag: SellerFlag, on: boolean): SellersState {
  return { ...state, filters: { ...state.filters, [flag]: on }, page: 1 };
}

/** The state with one id added to or removed from a filter group, back to the first 12. */
export function withSellerValue(
  state: SellersState,
  group: SellerGroup,
  id: string,
  on: boolean,
): SellersState {
  const rest = state.filters[group].filter((v) => v !== id);
  return {
    ...state,
    filters: { ...state.filters, [group]: on ? [...rest, id].sort() : rest },
    page: 1,
  };
}

/** The state with a distance set, or cleared with `undefined`, back to the first 12. */
export function withDistance(state: SellersState, distance: Distance | undefined): SellersState {
  return { ...state, filters: withoutDistance(state.filters, distance), page: 1 };
}

/** The filters with the distance replaced, or left out with `undefined`. */
export function withoutDistance(filters: SellerFilters, distance?: Distance): SellerFilters {
  const rest: SellerFilters = {
    newSellers: filters.newSellers,
    sameDay: filters.sameDay,
    certifications: filters.certifications,
    categories: filters.categories,
    minimums: filters.minimums,
  };
  return distance === undefined ? rest : { ...rest, distance };
}

export function withoutSellerFilters(state: SellersState): SellersState {
  return { ...state, filters: NO_SELLER_FILTERS, page: 1 };
}

export function withSellerSort(state: SellersState, sort: SellerSort): SellersState {
  return { ...state, sort, page: 1 };
}

export function withSellersPage(state: SellersState, page: number): SellersState {
  return { ...state, page };
}
