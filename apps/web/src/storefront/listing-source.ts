import 'server-only';
import {
  UUID,
  findInTree,
  categoryOf,
  readOnce,
  slugsOf,
  trailOf,
  countsOf,
  treeOf,
  type TreeRow,
} from './category-tree.ts';
import { liveParams, type LiveFilters } from '../catalog/live-filters.ts';
import { cardOf, isObject, moneyOf } from './home-source.ts';
import type { ApiRead } from './api.ts';
import type { PhotoUrl } from './photos.ts';
import type { Category, Money, ShelfCard } from './types.ts';

// The category and search pages' reads with the API on: `GET catalog/categories` to turn the URL's
// slug into the platform category id and `GET search/products` for the products. Every answer is
// checked here before it becomes a card (./home-source.ts `cardsOf`). Each function answers
// undefined while API_BASE_URL is empty, so ./catalog.ts keeps its sample. An outage throws: the
// page shows its error state rather than an empty list that says nothing matches.
//
// The route carries the attribute filters with their counts and, per item, the lowest price of the
// matching in-stock variants and the variant a filter chose (variants V8). It carries no seller
// name, total or sort, so the pager has `hasMore` only. What it cannot do is not faked here;
// ./catalog.ts and the pages leave those parts out.

export type Reader = (path: string) => Promise<ApiRead<unknown>>;

/** The API's refusal or silence about a read the page cannot render without. */
export class ListingReadFailed extends Error {
  constructor(what: string) {
    super(`the ${what} read failed`);
  }
}

/** The live tree's rows; undefined with the API off; throws when the tree cannot be read. */
async function treeRows(read: Reader): Promise<TreeRow[] | undefined> {
  const answer = await read('catalog/categories');
  if (answer.kind === 'off') return undefined;
  const rows = answer.kind === 'ok' ? treeOf(answer.body) : null;
  if (rows === null) throw new ListingReadFailed('category tree');
  return rows;
}

/** A category of the URL (`/c/<code>/<sub>`) from the live tree. */
export interface CategoryScope {
  readonly category: Category;
  readonly child?: { readonly code: string; readonly name: string };
}

/**
 * The category (and subcategory) a URL names: undefined with the API off, null when the tree has
 * no such slug (the page is a 404), else the category with its direct children as chips.
 */
export async function liveCategory(
  code: string,
  sub?: string,
  read: Reader = readOnce,
): Promise<CategoryScope | null | undefined> {
  const rows = await treeRows(read);
  if (rows === undefined) return undefined;
  const found = findInTree(rows, code, sub);
  if (found === undefined) return null;
  const trail = trailOf(rows, found.node);
  const { shortDescription, seo, hasLiveProducts } = found.node;
  const counts = countsOf(rows, found.node);
  return {
    category: {
      ...categoryOf(rows, found.node),
      page: {
        trail: trail.map((r) => ({ code: r.slug, name: r.name })),
        depth: trail.length,
        ...(shortDescription === undefined ? {} : { shortDescription }),
        ...(seo === undefined ? {} : { seo }),
        ...(hasLiveProducts === undefined ? {} : { hasLiveProducts }),
        ...(counts === undefined
          ? {}
          : { childCounts: counts.children, directCount: counts.direct }),
      },
    },
    ...(found.child === undefined
      ? {}
      : { child: { code: found.child.slug, name: found.child.name } }),
  };
}

export interface LiveQuery {
  readonly q?: string;
  readonly category?: string;
  readonly subcategory?: string;
  /** Only the products on the category itself ("Other {name}", categories C6). */
  readonly direct?: boolean;
  /** Attribute and price filters, in the API's words. */
  readonly filters?: LiveFilters;
  readonly page: number;
  readonly pageSize: number;
}

/** One option of a live filter, as the API counts it. */
export interface LiveFilterOption {
  readonly code: string;
  readonly label: string;
  /** Products this option would show; null when the API did not count it. */
  readonly count: number | null;
  readonly selected: boolean;
}

/** A filter the API offers for the listing: a choice of options or a yes switch. */
export interface LiveFilterGroup {
  readonly code: string;
  readonly name: string;
  readonly kind: 'choice' | 'toggle';
  readonly options: readonly LiveFilterOption[];
}

/** The variant a GTIN query names exactly: the search page opens it. */
export interface ExactMatch {
  readonly productId: string;
  readonly variantId: string;
}

export interface LivePage {
  readonly items: readonly ShelfCard[];
  readonly hasMore: boolean;
  /** The filters of the listing with their counts (never ranges: the page has no control for one). */
  readonly filters: readonly LiveFilterGroup[];
  /** Present when the query was a GTIN of a variant on sale. */
  readonly exactMatch?: ExactMatch;
}

const CODE = /^[a-z0-9][a-z0-9_-]{0,79}$/u;

/** The API's `filters`: well-formed choice and toggle groups; anything else is dropped. */
export function liveFilterGroupsOf(value: unknown): LiveFilterGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: LiveFilterGroup[] = [];
  for (const raw of value as unknown[]) {
    if (!isObject(raw) || typeof raw.code !== 'string' || !CODE.test(raw.code)) continue;
    if (raw.kind !== 'choice' && raw.kind !== 'toggle') continue;
    if (typeof raw.name !== 'string' || raw.name.trim() === '' || !Array.isArray(raw.options))
      continue;
    const options: LiveFilterOption[] = [];
    for (const o of raw.options as unknown[]) {
      if (!isObject(o) || typeof o.code !== 'string' || !CODE.test(o.code)) continue;
      if (typeof o.label !== 'string' || o.label.trim() === '') continue;
      const count =
        typeof o.count === 'number' && Number.isSafeInteger(o.count) && o.count >= 0
          ? o.count
          : null;
      options.push({
        code: o.code,
        label: o.label.slice(0, 120),
        count,
        selected: o.selected === true,
      });
    }
    if (options.length > 0)
      groups.push({ code: raw.code, name: raw.name.slice(0, 120), kind: raw.kind, options });
  }
  return groups;
}

function exactMatchOf(value: unknown): ExactMatch | undefined {
  if (!isObject(value)) return undefined;
  const { productId, variantId } = value;
  return typeof productId === 'string' &&
    UUID.test(productId) &&
    typeof variantId === 'string' &&
    UUID.test(variantId)
    ? { productId, variantId }
    : undefined;
}

/**
 * A search item as a card: the shelf card (./home-source.ts) with the item's price (the lowest of
 * the matching in-stock variants, "From" when they differ) and the variant a filter chose. Search
 * prices always include tax; an item without one shows no price.
 */
export function searchCardOf(
  item: unknown,
  slugs: ReadonlyMap<string, string>,
  photo: PhotoUrl | null,
): ShelfCard | null {
  if (!isObject(item)) return null;
  const { price: rawPrice, variantId, ...rest } = item;
  const card = cardOf(rest, slugs, photo);
  if (card === null) return null;
  const price: Money | undefined = isObject(rawPrice) ? moneyOf(rawPrice.from) : undefined;
  return {
    ...card,
    ...(price === undefined
      ? {}
      : { price, ...(isObject(rawPrice) && rawPrice.varies === true ? { priceFrom: true } : {}) }),
    ...(typeof variantId === 'string' && UUID.test(variantId) ? { variantId } : {}),
  };
}

/**
 * One page of `GET search/products`. A category slug the tree does not know matches nothing (the
 * pages resolve their slug first, so this is a stale link). A bad body is a failed read; a bad
 * item is dropped and a product that two offers carry shows once.
 */
export async function liveProducts(
  query: LiveQuery,
  read: Reader = readOnce,
  photo: PhotoUrl | null = null,
): Promise<LivePage | undefined> {
  const rows = await treeRows(read);
  if (rows === undefined) return undefined;
  const params = new URLSearchParams();
  if (query.q !== undefined) params.set('q', query.q);
  if (query.category !== undefined) {
    const found = findInTree(rows, query.category, query.subcategory);
    if (found === undefined) return { items: [], hasMore: false, filters: [] };
    params.set('category', (found.child ?? found.node).id);
    if (query.direct === true) params.set('direct', 'true');
  }
  for (const [key, value] of liveParams(query.filters ?? { choices: [], price: null }))
    params.append(key, value);
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  const answer = await read(`search/products?${params.toString()}`);
  if (answer.kind === 'off') return undefined;
  const body = answer.kind === 'ok' ? answer.body : null;
  if (!isObject(body) || !Array.isArray(body.items) || typeof body.hasMore !== 'boolean')
    throw new ListingReadFailed('product search');
  // The card links to `/p/<productId>`: an item whose id is not a UUID is dropped here, before
  // it can become a link.
  const items = (body.items as unknown[]).filter(
    (item) => isObject(item) && typeof item.productId === 'string' && UUID.test(item.productId),
  );
  const slugs = slugsOf(rows);
  const seen = new Set<string>();
  const cards: ShelfCard[] = [];
  for (const item of items) {
    const card = searchCardOf(item, slugs, photo);
    if (card === null || seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
  }
  const exactMatch = exactMatchOf(body.exactMatch);
  return {
    items: cards,
    hasMore: body.hasMore,
    filters: liveFilterGroupsOf(body.filters),
    ...(exactMatch === undefined ? {} : { exactMatch }),
  };
}
