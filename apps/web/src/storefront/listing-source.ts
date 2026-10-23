import 'server-only';
import {
  UUID,
  findInTree,
  categoryOf,
  readOnce,
  slugsOf,
  treeOf,
  type TreeRow,
} from './category-tree.ts';
import { cardsOf, isObject } from './home-source.ts';
import type { ApiRead } from './api.ts';
import type { Category, ShelfCard } from './types.ts';

// The category and search pages' reads with the API on: `GET catalog/categories` to turn the URL's
// slug into the platform category id and `GET search/products` for the products. Every answer is
// checked here before it becomes a card (./home-source.ts `cardsOf`). Each function answers
// undefined while API_BASE_URL is empty, so ./catalog.ts keeps its sample. An outage throws: the
// page shows its error state rather than an empty list that says nothing matches.
//
// The route carries no price, seller name, total, facets or sort, so the cards have no price (and
// no add button) and the pager has `hasMore` only. What it cannot do is not faked here; ./catalog.ts
// and the pages leave those parts out.

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
  return {
    category: categoryOf(rows, found.node),
    ...(found.child === undefined
      ? {}
      : { child: { code: found.child.slug, name: found.child.name } }),
  };
}

export interface LiveQuery {
  readonly q?: string;
  readonly category?: string;
  readonly subcategory?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface LivePage {
  readonly items: readonly ShelfCard[];
  readonly hasMore: boolean;
}

/**
 * One page of `GET search/products`. A category slug the tree does not know matches nothing (the
 * pages resolve their slug first, so this is a stale link). A bad body is a failed read; a bad
 * item is dropped and a product that two offers carry shows once.
 */
export async function liveProducts(
  query: LiveQuery,
  read: Reader = readOnce,
): Promise<LivePage | undefined> {
  const rows = await treeRows(read);
  if (rows === undefined) return undefined;
  const params = new URLSearchParams();
  if (query.q !== undefined) params.set('q', query.q);
  if (query.category !== undefined) {
    const found = findInTree(rows, query.category, query.subcategory);
    if (found === undefined) return { items: [], hasMore: false };
    params.set('category', (found.child ?? found.node).id);
  }
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
  return { items: cardsOf({ items }, slugsOf(rows)), hasMore: body.hasMore };
}
