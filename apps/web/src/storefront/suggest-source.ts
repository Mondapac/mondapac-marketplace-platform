import 'server-only';
import { productHref } from './links.ts';
import { imageRefOf, type PhotoUrl } from './photos.ts';
import type { SuggestAnswer, SuggestProduct, SuggestStore } from '../search/suggest-types.ts';

// `GET search/suggest?q=` (search package 1b) as the header's suggestions: each entry checked
// field by field, the links and photo URLs built here from the ids. An entry that is not the
// expected shape is dropped on its own; a body that is not an object is no answer (undefined).

const MAX_PRODUCTS = 5;
const MAX_STORES = 3;
const STORE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : Array.from(trimmed).slice(0, max).join('');
}

function productOf(raw: unknown, photo: PhotoUrl | null): SuggestProduct | undefined {
  if (!isObject(raw)) return undefined;
  const id = text(raw.productId, 64);
  const name = text(raw.name, 200);
  const sellerName = text(raw.sellerName, 120);
  if (id === undefined || name === undefined || sellerName === undefined) return undefined;
  const ref = imageRefOf(raw.image);
  return {
    id,
    name,
    href: productHref(id, name),
    sellerName,
    categoryName: text(raw.categoryName, 120) ?? null,
    imageUrl:
      ref === undefined || photo === null ? null : (photo(id, ref.imageId, 'thumb') ?? null),
  };
}

function storeOf(raw: unknown): SuggestStore | undefined {
  if (!isObject(raw)) return undefined;
  const slug = text(raw.storeSlug, 50);
  const name = text(raw.name, 120);
  const count = raw.productCount;
  if (slug === undefined || !STORE_SLUG.test(slug) || name === undefined) return undefined;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
  return { slug, href: `/s/${slug}`, name, productCount: count };
}

/** The answer of the API's body, or undefined when the body is not a suggestion answer. */
export function suggestOf(body: unknown, photo: PhotoUrl | null): SuggestAnswer | undefined {
  if (!isObject(body) || !Array.isArray(body.products) || !Array.isArray(body.stores)) {
    return undefined;
  }
  const { total } = body;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return undefined;
  const products = (body.products as unknown[])
    .map((raw) => productOf(raw, photo))
    .filter((p): p is SuggestProduct => p !== undefined)
    .slice(0, MAX_PRODUCTS);
  const stores = (body.stores as unknown[])
    .map(storeOf)
    .filter((s): s is SuggestStore => s !== undefined)
    .slice(0, MAX_STORES);
  return { products, stores, total, totalIsCapped: body.totalIsCapped === true };
}
