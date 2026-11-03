import 'server-only';
import { headers } from 'next/headers';
import { apiGet } from '../storefront/api.ts';
import { MAX_PAGE, categoryIsEmpty } from '../storefront/catalog.ts';
import { treeOf, type TreeRow } from '../storefront/category-tree.ts';
import {
  storefrontApiConfig,
  storefrontHostFor,
  type StorefrontHost,
} from '../storefront/config.ts';
import { liveProducts, type Reader } from '../storefront/listing-source.ts';
import { categoryHref, productHref } from '../storefront/links.ts';
import { indexingOn } from './indexing.ts';

// The sitemap (SEO plan, package 4A): an index and children built from today's public reads
// (`catalog/categories`, `search/products`). The reads carry no reliable updatedAt, so no `lastmod`
// is sent (Google ignores one that is not accurate); package 4B adds a read that has it.

/** The only Market whose site may be indexed at launch (john's decision 1, SEO plan section 5). */
export const INDEXED_MARKET = 'AU';

/** The API's page size for `search/products`; the most it allows. */
export const PRODUCT_PAGE_SIZE = 48;
/** API pages read for one products child: 960 URLs, far below the 50,000 and 50 MB limits. */
export const PAGES_PER_CHILD = 20;
/** Children needed to reach page MAX_PAGE (4,800 products). */
export const PRODUCT_CHILDREN = Math.ceil(MAX_PAGE / PAGES_PER_CHILD);

/** Thrown when a read fails: the route answers 503 so the crawler retries. */
export class SitemapReadFailed extends Error {}

/**
 * The listed host of an AU request when indexing is on; otherwise undefined and the sitemap (and
 * the robots Sitemap line) do not exist. Indexing and the host are read per request.
 */
export async function sitemapHost(): Promise<StorefrontHost | undefined> {
  if (!indexingOn()) return undefined;
  const config = storefrontApiConfig();
  if (config === null) return undefined;
  const host = storefrontHostFor(config, (await headers()).get('host'));
  return host?.marketId === INDEXED_MARKET ? host : undefined;
}

const log = (line: Readonly<Record<string, unknown>>): void => {
  console.log(JSON.stringify(line));
};

/** How long a built answer is kept. The gate (switch and host) is checked before every use. */
export const CACHE_MS = 10 * 60 * 1000;
const MAX_CACHED = 32;
const built = new Map<string, { until: number; value: Promise<unknown> }>();

/** Drops every kept answer (tests). */
export function clearSitemapCache(): void {
  built.clear();
}

/**
 * One build per key and CACHE_MS: requests that arrive meanwhile share it, so an anonymous caller
 * cannot turn each fetch into 20 to 100 API reads. A failed build is dropped at once (503 is
 * never kept). Callers run it only after the gate, keyed by the Market origin.
 */
export function cached<T>(key: string, build: () => Promise<T>, now = Date.now()): Promise<T> {
  const kept = built.get(key);
  if (kept !== undefined && kept.until > now) return kept.value as Promise<T>;
  if (built.size >= MAX_CACHED) built.clear();
  const value = build();
  built.set(key, { until: now + CACHE_MS, value });
  value.catch(() => {
    if (built.get(key)?.value === value) built.delete(key);
  });
  return value;
}

/** A reader that asks the category tree once per request (route handlers get no React cache). */
export function memoReader(read: Reader = apiGet): Reader {
  const kept = new Map<string, ReturnType<Reader>>();
  return (path) => {
    if (path !== 'catalog/categories') return read(path);
    const known = kept.get(path) ?? read(path);
    kept.set(path, known);
    return known;
  };
}

const escapeXml = (text: string): string =>
  text.replace(/[&<>"']/gu, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  );

const absolute = (origin: string, path: string): string => new URL(path, origin).href;

export function urlSetXml(origin: string, paths: readonly string[]): string {
  const rows = paths.map((path) => `<url><loc>${escapeXml(absolute(origin, path))}</loc></url>`);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.join('')}</urlset>\n`
  );
}

export function indexXml(origin: string, names: readonly string[]): string {
  const rows = names.map(
    (name) => `<sitemap><loc>${escapeXml(absolute(origin, `/sitemaps/${name}`))}</loc></sitemap>`,
  );
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.join('')}</sitemapindex>\n`
  );
}

/** The home page and the sellers list. */
export const pagePaths = (): string[] => ['/', '/sellers'];

async function treeRows(read: Reader): Promise<TreeRow[]> {
  const answer = await read('catalog/categories');
  const rows = answer.kind === 'ok' ? treeOf(answer.body) : null;
  if (rows === null) throw new SitemapReadFailed('category tree');
  return rows;
}

const CATEGORY_BATCH = 8;
/** Most category pages checked for one sitemap; a Market's tree is far smaller. */
export const MAX_CATEGORY_NODES = 400;

/**
 * The category pages that are not empty: every top-level category and each of its direct children
 * (the page serves no deeper path), judged by the same rule as the page's robots tag.
 */
export async function categoryPaths(read: Reader = memoReader()): Promise<string[]> {
  const rows = await treeRows(read);
  const seen = new Set<string>();
  const nodes: { category: string; sub?: string }[] = [];
  for (const top of rows.filter((r) => r.parentId === null)) {
    if (seen.has(top.slug)) continue;
    seen.add(top.slug);
    nodes.push({ category: top.slug });
    const subs = new Set<string>();
    for (const child of rows.filter((r) => r.parentId === top.id)) {
      if (subs.has(child.slug)) continue;
      subs.add(child.slug);
      nodes.push({ category: top.slug, sub: child.slug });
    }
  }
  nodes.length = Math.min(nodes.length, MAX_CATEGORY_NODES);
  const paths: string[] = [];
  try {
    for (let i = 0; i < nodes.length; i += CATEGORY_BATCH) {
      const batch = nodes.slice(i, i + CATEGORY_BATCH);
      const empty = await Promise.all(
        batch.map((n) =>
          categoryIsEmpty(
            { category: n.category, ...(n.sub === undefined ? {} : { subcategory: n.sub }) },
            read,
          ),
        ),
      );
      batch.forEach((n, j) => {
        if (!empty[j]) paths.push(categoryHref(n.category, n.sub));
      });
    }
  } catch {
    throw new SitemapReadFailed('category listing');
  }
  return paths;
}

/** The API pages of products child `n` (1-based), or null when `n` is outside 1..PRODUCT_CHILDREN. */
function pageRange(n: number): { first: number; last: number } | null {
  if (!Number.isInteger(n) || n < 1 || n > PRODUCT_CHILDREN) return null;
  const first = (n - 1) * PAGES_PER_CHILD + 1;
  return { first, last: Math.min(first + PAGES_PER_CHILD - 1, MAX_PAGE) };
}

async function productPage(page: number, read: Reader) {
  try {
    const live = await liveProducts({ page, pageSize: PRODUCT_PAGE_SIZE }, read);
    if (live === undefined) throw new SitemapReadFailed('product search');
    return live;
  } catch {
    throw new SitemapReadFailed('product search');
  }
}

/**
 * The product pages of child `n`: pages of `search/products` until `hasMore` is false or the 4,800
 * cap. Reaching the cap with more left logs one line: that is the trigger for package 4B.
 * Null when `n` names no child.
 */
export async function productPaths(
  n: number,
  read: Reader = memoReader(),
): Promise<string[] | null> {
  const range = pageRange(n);
  if (range === null) return null;
  const ids = new Set<string>();
  for (let page = range.first; page <= range.last; page += 1) {
    const live = await productPage(page, read);
    for (const card of live.items) ids.add(card.id);
    if (!live.hasMore) break;
    if (page === MAX_PAGE) {
      log({ msg: 'storefront.sitemap-product-cap', products: MAX_PAGE * PRODUCT_PAGE_SIZE });
    }
  }
  return [...ids].map(productHref);
}

/** The index children, kept per Market origin for CACHE_MS. */
export const cachedChildNames = (origin: string): Promise<string[]> =>
  cached(`${origin}|index`, () => childNames());

/** The URL paths of a child, kept per Market origin for CACHE_MS; null for an unknown child. */
export const cachedChildPaths = (origin: string, name: string): Promise<string[] | null> =>
  /^(pages|categories)\.xml$|^products-[1-9][0-9]?\.xml$/u.test(name)
    ? cached(`${origin}|${name}`, () => childPaths(name))
    : Promise.resolve(null);

/** The children the index lists: pages, categories and each products child that has a product. */
export async function childNames(read: Reader = memoReader()): Promise<string[]> {
  const names = ['pages.xml', 'categories.xml'];
  for (let n = 1; n <= PRODUCT_CHILDREN; n += 1) {
    const range = pageRange(n);
    if (range === null) break;
    const live = await productPage(range.first, read);
    if (live.items.length === 0) break;
    names.push(`products-${n}.xml`);
  }
  return names;
}

/** `pages.xml`, `categories.xml` or `products-N.xml` as the XML paths of that child; null if none. */
export async function childPaths(
  name: string,
  read: Reader = memoReader(),
): Promise<string[] | null> {
  if (name === 'pages.xml') return pagePaths();
  if (name === 'categories.xml') return categoryPaths(read);
  const match = /^products-([1-9][0-9]?)\.xml$/u.exec(name);
  return match === null ? null : productPaths(Number(match[1]), read);
}
