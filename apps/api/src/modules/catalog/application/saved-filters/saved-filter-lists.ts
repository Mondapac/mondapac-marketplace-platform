import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { AdminProductsFilter } from '../ports/admin-products.reader';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import {
  ADMIN_PRODUCT_SORTS,
  filterOfSelector,
  parseSelector,
  type AdminProductView,
} from '../use-cases/admin-products-list.use-case';

// The admin lists that can keep saved filters (catalog design 9.2d). A list is named by a dotted
// key; its entry says which permission shows the list and how to read the document it saves.
// Adding a list is one entry here (and its key in the audit vocabulary and the migration's key
// pattern, which already allows any dotted key). The use cases check `catalog.product.view`, the
// key of the first list; a later list with another view key needs that check added to them, and
// the test of this file fails until it is.

/** The saved document of the product list: the tab, search, filters and sort it was saved from. */
export interface ProductsFilterPayload {
  readonly v: 1;
  readonly view: AdminProductView;
  readonly q?: string;
  readonly filters: {
    readonly scope?: string;
    readonly status?: string;
    readonly categoryId?: string;
    readonly typeCode?: string;
    readonly sellerId?: string;
  };
  readonly sort: (typeof ADMIN_PRODUCT_SORTS)[number];
  readonly direction: 'asc' | 'desc';
}

export interface SavedFilterListDefinition {
  readonly key: string;
  /** The permission that lets an admin see the list, hence its saved views. */
  readonly viewKey: string;
  /** The closed document of a request or a stored row, in its canonical form. */
  parsePayload(raw: unknown): Result<ProductsFilterPayload, ValidationFailure>;
  /** The products a saved document matches, to count them; null when the list has no count. */
  countFilter(payload: ProductsFilterPayload, locale: string): AdminProductsFilter | null;
}

const PAYLOAD_KEYS = new Set(['v', 'view', 'q', 'filters', 'sort', 'direction']);
const FILTER_KEYS = ['scope', 'status', 'categoryId', 'typeCode', 'sellerId'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProductsPayload(raw: unknown): Result<ProductsFilterPayload, ValidationFailure> {
  if (!isRecord(raw)) return invalid('payload', 'type');
  for (const key of Object.keys(raw))
    if (!PAYLOAD_KEYS.has(key)) return invalid(`payload.${key}`, 'unknown');
  if (raw['v'] !== 1) return invalid('payload.v', 'value');
  for (const key of ['view', 'sort', 'direction'] as const) {
    if (raw[key] === undefined) return invalid(`payload.${key}`, 'required');
  }
  const filtersRaw = raw['filters'] ?? {};
  if (!isRecord(filtersRaw)) return invalid('payload.filters', 'type');
  for (const key of Object.keys(filtersRaw)) {
    if (!(FILTER_KEYS as readonly string[]).includes(key)) {
      return invalid(`payload.filters.${key}`, 'unknown');
    }
  }
  // The tab and the search through the list's own reading, then the filters through it again, so a
  // saved value is exactly one the list would accept.
  const top = parseSelector({ view: raw['view'], q: raw['q'] }, 'payload.');
  if (!top.ok) return top;
  const filters = parseSelector(filtersRaw, 'payload.filters.');
  if (!filters.ok) return filters;
  const sort = ADMIN_PRODUCT_SORTS.find((candidate) => candidate === raw['sort']);
  if (sort === undefined) return invalid('payload.sort', 'value');
  const direction = raw['direction'];
  if (direction !== 'asc' && direction !== 'desc') return invalid('payload.direction', 'value');
  const f = filters.value;
  return ok({
    v: 1,
    view: top.value.view,
    ...(top.value.text === null ? {} : { q: top.value.text }),
    filters: {
      ...(f.scope === null ? {} : { scope: f.scope }),
      ...(f.status === null ? {} : { status: f.status }),
      ...(f.categoryId === null ? {} : { categoryId: f.categoryId }),
      ...(f.typeCode === null ? {} : { typeCode: f.typeCode }),
      ...(f.sellerId === null ? {} : { sellerId: f.sellerId }),
    },
    sort,
    direction,
  });
}

/** The tab, search and filters of a saved document as the list reads them. */
function selectorOf(payload: ProductsFilterPayload) {
  const parsed = parseSelector({ view: payload.view, q: payload.q, ...payload.filters });
  // A document in canonical form always parses; a failure here means the list's vocabulary
  // moved on since it was saved, and the saved view then counts nothing.
  return parsed.ok ? parsed.value : null;
}

const PRODUCTS_LIST: SavedFilterListDefinition = {
  key: 'admin.catalog.products',
  viewKey: CATALOG_PRODUCT_VIEW.key,
  parsePayload: parseProductsPayload,
  countFilter(payload, locale) {
    const selector = selectorOf(payload);
    return selector === null ? null : filterOfSelector(selector, payload.view, locale);
  },
};

export const SAVED_FILTER_LISTS: Readonly<Record<string, SavedFilterListDefinition>> =
  Object.freeze({ [PRODUCTS_LIST.key]: PRODUCTS_LIST });

export const SAVED_FILTER_LIST_KEYS: readonly string[] = Object.keys(SAVED_FILTER_LISTS);

/** The list a request names, or null for a key that is no list. */
export const savedFilterListOf = (value: unknown): SavedFilterListDefinition | null =>
  typeof value === 'string' && Object.hasOwn(SAVED_FILTER_LISTS, value)
    ? (SAVED_FILTER_LISTS[value] ?? null)
    : null;
