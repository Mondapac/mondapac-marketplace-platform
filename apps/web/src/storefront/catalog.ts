import 'server-only';
import { PRODUCTS } from './sample-home.ts';
import { SAMPLE_SUBCATEGORY } from './sample-catalog.ts';
import type { ProductCard } from './types.ts';

// The category and search pages' one read of products. It follows the contract of
// `GET /search/products` (q 2 to 100 characters, page 1 to 100, pageSize 1 to 48, `hasMore`
// instead of a total) and answers from the sample content until PR #401 and storefront
// package 2 are on main; only this file changes when the route is wired.

export const PAGE_SIZE = 24;
export const MAX_PAGE = 100;
export const QUERY_MIN = 2;
export const QUERY_MAX = 100;

export interface ProductQuery {
  /** Search words, already trimmed; absent to list a category. */
  readonly q?: string;
  /** Category code (the API takes the platform category id). */
  readonly category?: string;
  readonly subcategory?: string;
  readonly page: number;
  readonly pageSize?: number;
}

export interface ProductPage {
  readonly items: readonly ProductCard[];
  readonly page: number;
  readonly pageSize: number;
  /** True when a later page has items; the API gives no total. */
  readonly hasMore: boolean;
}

/** The page number of a `?page=` value: a whole number from 1 to 100, otherwise 1. */
export function pageOf(value: string | string[] | undefined): number {
  const text = Array.isArray(value) ? value[0] : value;
  if (text === undefined || !/^[0-9]{1,3}$/u.test(text)) return 1;
  const page = Number(text);
  return page >= 1 && page <= MAX_PAGE ? page : 1;
}

/** The search words of a `?q=` value, trimmed and cut to the API's limit. */
export function queryOf(value: string | string[] | undefined): string {
  const text = (Array.isArray(value) ? value[0] : value) ?? '';
  return Array.from(text.trim().replace(/\s+/gu, ' ')).slice(0, QUERY_MAX).join('');
}

export async function findProducts(query: ProductQuery): Promise<ProductPage> {
  const pageSize = query.pageSize ?? PAGE_SIZE;
  const words = (query.q ?? '').toLowerCase().split(' ').filter(Boolean);
  const matches = PRODUCTS.filter(
    (p) =>
      (query.category === undefined || p.category === query.category) &&
      (query.subcategory === undefined || SAMPLE_SUBCATEGORY[p.id] === query.subcategory) &&
      words.every((w) => `${p.name} ${p.sellerName} ${p.category}`.toLowerCase().includes(w)),
  );
  const start = (query.page - 1) * pageSize;
  return Promise.resolve({
    items: matches.slice(start, start + pageSize),
    page: query.page,
    pageSize,
    hasMore: matches.length > start + pageSize,
  });
}
