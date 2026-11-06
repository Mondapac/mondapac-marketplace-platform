import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import { productHref, productIdOfSegment } from './links.ts';
import { loadProduct, loadUnavailableProduct } from './source.ts';
import type { ProductDetail, UnavailableProduct } from './types.ts';

type Query = Record<string, string | string[] | undefined>;

/** The query of the request, written back as it came (`?v=` and the rest survive a redirect). */
function queryString(query: Query): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) out.append(key, one);
  }
  const text = out.toString();
  return text === '' ? '' : `?${text}`;
}

/** The segment as the browser sent it, decoded; null when it is not valid percent-encoding. */
function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The product of the segment's id, read once per request; undefined when there is none. */
const findProduct = cache(async (id: string) => {
  const product = await loadProduct(id);
  if (product) return { product } as const;
  return undefined;
});

/**
 * The removed product behind a `/p/<segment>` path, for the 404 page's body; undefined for a path
 * that is no removed product. The not-found page gets no params, so it reads the path the proxy
 * recorded in `PATH_HEADER`.
 */
export async function removedProductOfPath(
  path: string | null,
): Promise<UnavailableProduct | undefined> {
  const prefix = '/p/';
  if (path === null || !path.startsWith(prefix)) return undefined;
  const segment = decoded(path.slice(prefix.length));
  return segment === null ? undefined : loadUnavailableProduct(productIdOfSegment(segment));
}

/**
 * The product for the head tags: undefined for a removed or unknown one, which never throws.
 * A throw from `generateMetadata` ends in a 404 whose body is built in the browser; the page
 * itself leaves through `resolveProduct`, which answers with server-rendered HTML.
 */
export async function productForMetadata(segment: string): Promise<ProductDetail | undefined> {
  return (await findProduct(productIdOfSegment(segment)))?.product;
}

/**
 * The product of `/p/<segment>`, decided before anything of the page is sent:
 * - found, and the segment is not `<slug>-<id>` of its current name: a permanent redirect
 *   (`permanentRedirect`, HTTP 308, which Google treats like 301) to the path built from the id
 *   and the product's name, never from the request's text; the query string is kept;
 * - removed: 404, whose body is the removed product's page (`removedProductOfPath`);
 * - unknown, or no id at the end of the segment: 404.
 * A segment that is not a catalog id only exists in the sample data.
 */
export async function resolveProduct(
  segment: string,
  query: Query,
): Promise<{ readonly product: ProductDetail; readonly path: string }> {
  const found = await findProduct(productIdOfSegment(segment));
  if (!found) notFound();
  const { product } = found;
  const path = productHref(product.id, product.name);
  if (decoded(segment) !== decoded(path.slice('/p/'.length))) {
    permanentRedirect(`${path}${queryString(query)}`);
  }
  return { product, path };
}
