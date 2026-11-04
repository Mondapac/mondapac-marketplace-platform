import { cardsOf, isObject, textOf } from './home-source.ts';
import type { PhotoUrl } from './photos.ts';
import type {
  Brand,
  BrandEntry,
  BrandImage,
  BrandIndex,
  BrandPage,
  StoreProducts,
} from './types.ts';

// The buyer brand pages on real data (design B5): `GET catalog/brands` (the A to Z list),
// `GET catalog/brands/<slug>` (an active brand with its live product count) and
// `GET search/products?brand=<slug>` (a page of the brand's products in the buyer's Market). Every
// answer is untrusted: it is checked field by field here before it becomes a link, a heading or a
// card, and a malformed body is a failed read, never half a page.

/** The shape of a brand slug (catalog `isBrandSlug`): words joined by single hyphens, 80 at most. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const SLUG_MAX = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Cards under the header: the short list that ends with "See all N". */
export const BRAND_PREVIEW_SIZE = 8;
/** Cards per page of the full list. */
export const BRAND_PAGE_SIZE = 24;
/** The API refuses a page beyond this (search `MAX_PAGE`). */
export const BRAND_MAX_PAGE = 100;

export const isBrandSlug = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= SLUG_MAX && SLUG.test(value);

/**
 * Where a brand's picture is served from, by its image id. None yet: the brand's own image upload
 * and its public route are a later package (the API holds only the ids), so no brand shows a
 * picture and the page uses its monogram and the neutral header. The parsers below take this as a
 * parameter, so the day the route exists only the argument of the loader changes.
 */
export type BrandImageSource = (imageId: string) => BrandImage | undefined;

export const NO_BRAND_IMAGES: BrandImageSource = () => undefined;

const logoOf = (
  id: unknown,
  alt: unknown,
  images: BrandImageSource,
): (BrandImage & { readonly alt: string }) | undefined => {
  const text = textOf(alt, 200);
  if (typeof id !== 'string' || !UUID.test(id) || text === undefined) return undefined;
  const image = images(id);
  return image === undefined ? undefined : { ...image, alt: text };
};

/** The page number of a `?page=` value: a whole number from 1 up, else 1. */
export function brandPageNumber(value: string | string[] | undefined): number {
  if (typeof value !== 'string' || !/^[0-9]{1,3}$/u.test(value)) return 1;
  const page = Number(value);
  return page >= 1 && page <= BRAND_MAX_PAGE ? page : 1;
}

/** Whether `?all=1` asks for the full list. */
export const brandAllOf = (value: string | string[] | undefined): boolean => value === '1';

/** The API path of one page of a brand's products; `slug` is already checked. */
export function brandProductsPath(slug: string, page: number, pageSize: number): string {
  const params = new URLSearchParams({
    brand: slug,
    page: String(page),
    pageSize: String(pageSize),
  });
  return `search/products?${params.toString()}`;
}

/** The brand of the A to Z answer, or null when the body is not one. */
export function brandIndexOf(
  body: unknown,
  images: BrandImageSource = NO_BRAND_IMAGES,
): BrandIndex | null {
  if (!isObject(body) || !Array.isArray(body.sections) || typeof body.truncated !== 'boolean')
    return null;
  const sections: { letter: string; brands: BrandEntry[] }[] = [];
  const seen = new Set<string>();
  for (const raw of body.sections as unknown[]) {
    if (!isObject(raw) || typeof raw.letter !== 'string' || !Array.isArray(raw.brands)) return null;
    // `A` to `Z`, or `#`: one character, never markup.
    if (!/^[A-Z#]$/u.test(raw.letter)) continue;
    const brands: BrandEntry[] = [];
    for (const item of raw.brands as unknown[]) {
      if (!isObject(item)) continue;
      const name = textOf(item.name, 120);
      if (!isBrandSlug(item.slug) || name === undefined || seen.has(item.slug)) continue;
      seen.add(item.slug);
      const logo = logoOf(item.logoImageId, item.logoAlt, images);
      brands.push({ slug: item.slug, name, ...(logo === undefined ? {} : { logo }) });
    }
    if (brands.length > 0) sections.push({ letter: raw.letter, brands });
  }
  return { sections, truncated: body.truncated };
}

/** The brand of the page's answer, or null when the body is not a brand. */
export function brandOf(body: unknown, images: BrandImageSource = NO_BRAND_IMAGES): Brand | null {
  if (!isObject(body)) return null;
  const name = textOf(body.name, 120);
  const { productCount } = body;
  if (!isBrandSlug(body.slug) || name === undefined) return null;
  if (typeof productCount !== 'number' || !Number.isSafeInteger(productCount) || productCount < 0)
    return null;
  const summary = textOf(body.summary, 1000);
  const country =
    typeof body.originCountry === 'string' && /^[A-Z]{2}$/u.test(body.originCountry)
      ? body.originCountry
      : undefined;
  const logo = logoOf(body.logoImageId, body.logoAlt, images);
  const header =
    typeof body.headerImageId === 'string' && UUID.test(body.headerImageId)
      ? images(body.headerImageId)
      : undefined;
  return {
    slug: body.slug,
    name,
    ...(summary === undefined ? {} : { summary }),
    ...(country === undefined ? {} : { originCountry: country }),
    ...(logo === undefined ? {} : { logo }),
    ...(header === undefined ? {} : { header }),
    productCount,
  };
}

/**
 * The products of the brand from the API's search answer. A body that is not a page (no `items`
 * list, no boolean `hasMore`) is `failed`: the section says so, the rest of the page stays.
 */
export function brandProductsOf(
  body: unknown,
  page: number,
  slugs: ReadonlyMap<string, string>,
  photo: PhotoUrl | null,
): StoreProducts {
  if (!isObject(body)) return { kind: 'failed', page };
  const { items, hasMore } = body;
  if (!Array.isArray(items) || typeof hasMore !== 'boolean') return { kind: 'failed', page };
  return { kind: 'ok', items: cardsOf({ items }, slugs, photo), page, hasMore };
}

/** The page from its parts, in one place so the loader and the sample build it the same way. */
export const brandPageOf = (brand: Brand, products: StoreProducts, all: boolean): BrandPage => ({
  brand,
  products,
  all,
});
