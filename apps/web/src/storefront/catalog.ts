import 'server-only';
import { NO_FILTERS, type ListingFilters, type Sort } from '../catalog/listing-state.ts';
import {
  SAMPLE_CERTIFICATION_NAMES,
  SAMPLE_LISTING_BANNERS,
  SAMPLE_PRICE_BANDS,
  SAMPLE_PRODUCTS,
  SAMPLE_SAME_DAY_SELLERS,
  SAMPLE_SUBCATEGORY,
  sampleSellerId,
} from './sample-catalog.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import type { ListingBanner, PriceBand, ProductCard } from './types.ts';

// The category and search pages' one read of products. It follows the contract of
// `GET /search/products` (q 2 to 100 characters, page 1 to 100, pageSize 1 to 48, `hasMore`
// instead of a total) and answers from the sample content until PR #401 and storefront
// package 2 are on main; only this file changes when the route is wired. Filters, sort, the
// total and the facet counts of the listing page are not in that route yet: the sample answers
// them so the approved design can be built, and the backend adds them as their own package.

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
  /** Listing filters; not in the API yet. */
  readonly filters?: ListingFilters;
  /** Listing order; not in the API yet. */
  readonly sort?: Sort;
}

export interface ProductPage {
  readonly items: readonly ProductCard[];
  readonly page: number;
  readonly pageSize: number;
  /** True when a later page has items; the API gives no total. */
  readonly hasMore: boolean;
  /** Number of matching products, when the source knows it (the listing's sample does). */
  readonly total?: number;
}

/** One option of a filter group with the number of products it holds in the listing. */
export interface FacetOption {
  readonly id: string;
  readonly count: number;
}

/** What the filters of one listing can offer, counted within its category. */
export interface ListingFacets {
  readonly special: number;
  readonly sameDay: number;
  readonly lowStock: number;
  readonly certifications: readonly (FacetOption & { readonly name: string })[];
  readonly sellers: readonly (FacetOption & { readonly name: string })[];
  readonly prices: readonly (FacetOption & { readonly band: PriceBand })[];
}

export const LISTING_PAGE_SIZE = 12;

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

function inBand(product: ProductCard, band: PriceBand): boolean {
  const { amount, currency } = product.price;
  const fits = (bound: PriceBand['below'], test: (limit: number) => boolean) =>
    bound === undefined || (bound.currency === currency && test(bound.amount));
  return (
    fits(band.below, (limit) => amount < limit) &&
    fits(band.above, (limit) => amount > limit) &&
    fits(band.from, (limit) => amount >= limit) &&
    fits(band.to, (limit) => amount <= limit)
  );
}

const sameDay = (p: ProductCard) => SAMPLE_SAME_DAY_SELLERS.has(sampleSellerId(p) ?? '');
const certified = (p: ProductCard, type: string) => p.certifications.some((c) => c.type === type);

function matchesFilters(p: ProductCard, filters: ListingFilters): boolean {
  if (filters.special && p.wasPrice === undefined) return false;
  if (filters.sameDay && !sameDay(p)) return false;
  if (filters.lowStock && p.lowStock === undefined) return false;
  if (!filters.certifications.every((type) => certified(p, type))) return false;
  if (filters.sellers.length > 0 && !filters.sellers.includes(sampleSellerId(p) ?? ''))
    return false;
  const bands = SAMPLE_PRICE_BANDS.filter((b) => filters.prices.includes(b.id));
  if (filters.prices.length > 0 && !bands.some((b) => inBand(p, b))) return false;
  return true;
}

const discount = (p: ProductCard) => (p.wasPrice ? p.wasPrice.amount - p.price.amount : 0);

/** Sample orders; "best seller" puts the products that are selling out first. */
const ORDER: Readonly<Record<Sort, (a: ProductCard, b: ProductCard) => number>> = {
  recommended: () => 0,
  'best-seller': (a, b) => Number(b.lowStock !== undefined) - Number(a.lowStock !== undefined),
  'price-asc': (a, b) => a.price.amount - b.price.amount,
  'price-desc': (a, b) => b.price.amount - a.price.amount,
  discount: (a, b) => discount(b) - discount(a),
  name: (a, b) => a.name.localeCompare(b.name),
};

function inScope(query: Pick<ProductQuery, 'q' | 'category' | 'subcategory'>) {
  const words = (query.q ?? '').toLowerCase().split(' ').filter(Boolean);
  return SAMPLE_PRODUCTS.filter(
    (p) =>
      (query.category === undefined || p.category === query.category) &&
      (query.subcategory === undefined || SAMPLE_SUBCATEGORY[p.id] === query.subcategory) &&
      words.every((w) => `${p.name} ${p.sellerName} ${p.category}`.toLowerCase().includes(w)),
  );
}

export async function findProducts(query: ProductQuery): Promise<ProductPage> {
  const pageSize = query.pageSize ?? PAGE_SIZE;
  const filters = query.filters ?? NO_FILTERS;
  const matches = inScope(query)
    .filter((p) => matchesFilters(p, filters))
    .sort(ORDER[query.sort ?? 'recommended']);
  const start = (query.page - 1) * pageSize;
  return Promise.resolve({
    items: matches.slice(start, start + pageSize),
    page: query.page,
    pageSize,
    hasMore: matches.length > start + pageSize,
    total: matches.length,
  });
}

/** The filter options of a category listing with their counts (not narrowed by other filters). */
export async function listingFacets(
  query: Pick<ProductQuery, 'category' | 'subcategory'>,
): Promise<ListingFacets> {
  const products = inScope(query);
  const count = (test: (p: ProductCard) => boolean) => products.filter(test).length;
  return Promise.resolve({
    special: count((p) => p.wasPrice !== undefined),
    sameDay: count(sameDay),
    lowStock: count((p) => p.lowStock !== undefined),
    certifications: Object.entries(SAMPLE_CERTIFICATION_NAMES).map(([id, name]) => ({
      id,
      name,
      count: count((p) => certified(p, id)),
    })),
    sellers: [...SAMPLE_CONTENT.sellers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ id: s.id, name: s.name, count: count((p) => sampleSellerId(p) === s.id) }))
      .filter((s) => s.count > 0),
    prices: SAMPLE_PRICE_BANDS.map((band) => ({
      id: band.id,
      band,
      count: count((p) => inBand(p, band)),
    })),
  });
}

/** The promotion banner of a category listing, if its content slot has one. */
export async function listingBanner(category: string): Promise<ListingBanner | undefined> {
  return Promise.resolve(SAMPLE_LISTING_BANNERS[category]);
}
