import type { Money, SellerListing, SellerResults, SellerShop, StoreImage } from './types.ts';

// The API's public store answers (`GET sellers/stores`, `GET sellers/stores/:slug`) as the
// storefront's seller types. The body is untrusted: anything that is not the expected shape is
// refused whole, never shown in part. The API answers only what it holds today (name, area, year,
// minimum order, About text, logo and banner); every other field stays absent, and the pages leave
// its part out rather than show a value nobody gave (no "no certificates", no "0 products").

/** A logo or banner as the API names it: the id of the picture and its pixels at the large size. */
export interface PublicStoreImage {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** A store as the API answers it. */
export interface PublicStore {
  readonly slug: string;
  readonly name: string;
  readonly serviceAreaCode: string;
  readonly sellingSince: number;
  /** null: no minimum. Absent: not known now, so no minimum line is shown. */
  readonly minimumOrder?: Money | null;
  /** The About text, plain: a store page only. null or absent: none written. */
  readonly about?: string | null;
  /** The current logo (the page and the list) and banner (the page only). */
  readonly logo?: PublicStoreImage | null;
  readonly banner?: PublicStoreImage | null;
}

export class StoreAnswerRefused extends Error {
  constructor(what: string) {
    super(`the API's store answer is not the expected shape: ${what}`);
  }
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^[0-9]{1,15}$/;
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The API allows 2000 characters; a longer text is not what it sends, so it is refused whole. */
const ABOUT_MAX_UNITS = 8000;
const IMAGE_SIDE_MAX = 10000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function moneyOf(value: unknown): Money | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) throw new StoreAnswerRefused('minimumOrder');
  const { amount, currency } = value;
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
    throw new StoreAnswerRefused('minimumOrder.amount');
  }
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    throw new StoreAnswerRefused('minimumOrder.currency');
  }
  return { amount: Number(amount), currency };
}

function imageOf(value: unknown, field: string): PublicStoreImage | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) throw new StoreAnswerRefused(field);
  const { id, width, height } = value;
  if (typeof id !== 'string' || !IMAGE_ID.test(id)) throw new StoreAnswerRefused(`${field}.id`);
  for (const side of [width, height]) {
    if (typeof side !== 'number' || !Number.isInteger(side) || side < 1 || side > IMAGE_SIDE_MAX) {
      throw new StoreAnswerRefused(`${field}.size`);
    }
  }
  return { id, width: width as number, height: height as number };
}

function aboutOf(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || value.length > ABOUT_MAX_UNITS) {
    throw new StoreAnswerRefused('about');
  }
  return value;
}

/** One store of the API's answer, checked field by field. */
export function publicStoreOf(value: unknown): PublicStore {
  if (!isRecord(value)) throw new StoreAnswerRefused('store');
  const { slug, name, serviceAreaCode, sellingSince } = value;
  if (typeof slug !== 'string' || slug.length > 50 || !SLUG.test(slug)) {
    throw new StoreAnswerRefused('slug');
  }
  if (typeof name !== 'string' || name.trim() === '' || name.length > 100) {
    throw new StoreAnswerRefused('name');
  }
  if (typeof serviceAreaCode !== 'string' || !CODE.test(serviceAreaCode)) {
    throw new StoreAnswerRefused('serviceAreaCode');
  }
  if (
    typeof sellingSince !== 'number' ||
    !Number.isInteger(sellingSince) ||
    sellingSince < 2000 ||
    sellingSince > new Date().getUTCFullYear() + 1
  ) {
    throw new StoreAnswerRefused('sellingSince');
  }
  const minimumOrder = moneyOf(value['minimumOrder']);
  const about = aboutOf(value['about']);
  const logo = imageOf(value['logo'], 'logo');
  const banner = imageOf(value['banner'], 'banner');
  const store = {
    slug,
    name,
    serviceAreaCode,
    sellingSince,
    ...(about === undefined ? {} : { about }),
    ...(logo === undefined ? {} : { logo }),
    ...(banner === undefined ? {} : { banner }),
  };
  return minimumOrder === undefined ? store : { ...store, minimumOrder };
}

/**
 * Where the buyer site serves a store picture from: its own route, which asks the API
 * (`/s/<slug>/images/<id>/<size>`), so the browser never needs the API's address.
 */
export const storeImageSrc = (slug: string, id: string, size: 'small' | 'large'): string =>
  `/s/${slug}/images/${id}/${size}`;

function pictureOf(
  slug: string,
  image: PublicStoreImage | null | undefined,
  size: 'small' | 'large',
  pixels: { readonly width: number; readonly height: number } | undefined,
): StoreImage | undefined {
  if (image === null || image === undefined) return undefined;
  return {
    src: storeImageSrc(slug, image.id, size),
    width: pixels?.width ?? image.width,
    height: pixels?.height ?? image.height,
  };
}

/** A page of the list: its stores and the count of every store that sells now. */
export function publicStorePageOf(value: unknown): {
  readonly items: readonly PublicStore[];
  readonly total: number;
} {
  if (!isRecord(value) || !Array.isArray(value['items'])) throw new StoreAnswerRefused('page');
  const total = value['total'];
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    throw new StoreAnswerRefused('total');
  }
  return { items: value['items'].map(publicStoreOf), total };
}

/** The store page from a public store; `area` is the display name of its ServiceArea. */
export function shopOf(store: PublicStore, area: string): SellerShop {
  const shop: SellerShop = {
    id: store.slug,
    name: store.name,
    location: area,
    sellingSince: store.sellingSince,
  };
  const logoImage = pictureOf(store.slug, store.logo, 'large', undefined);
  const banner = pictureOf(store.slug, store.banner, 'large', undefined);
  const about = store.about === null || store.about === undefined ? '' : store.about.trim();
  const withParts: SellerShop = {
    ...shop,
    ...(about === '' ? {} : { about }),
    ...(logoImage === undefined ? {} : { logoImage }),
    ...(banner === undefined ? {} : { banner }),
  };
  if (store.minimumOrder === undefined) return { ...withParts, minimumUnknown: true };
  return store.minimumOrder === null
    ? withParts
    : { ...withParts, minimumOrder: store.minimumOrder };
}

/** One card of the sellers page from a public store. */
export function listingOf(store: PublicStore, area: string): SellerListing {
  const listing: SellerListing = {
    id: store.slug,
    name: store.name,
    city: area,
    sellingSince: store.sellingSince,
    certifications: [],
    categories: [],
    sameDay: false,
    thumbnails: [],
    deliversHere: true,
  };
  const logoImage = pictureOf(store.slug, store.logo, 'small', { width: 128, height: 128 });
  const withLogo: SellerListing = logoImage === undefined ? listing : { ...listing, logoImage };
  if (store.minimumOrder === undefined) return { ...withLogo, minimumUnknown: true };
  return store.minimumOrder === null ? withLogo : { ...withLogo, minimumOrder: store.minimumOrder };
}

/** The sellers page's read from real stores: no filter or facet the API cannot answer yet. */
export function sellerResultsOf(
  stores: readonly PublicStore[],
  total: number,
  areaOf: (code: string) => string,
): SellerResults {
  return {
    items: stores.map((store) => listingOf(store, areaOf(store.serviceAreaCode))),
    total,
    all: total,
    location: 'unknown',
    facets: {
      newSellers: 0,
      sameDay: 0,
      certifications: [],
      categories: [],
      minimums: [],
      distances: [],
    },
    sorts: ['name', 'newest'],
    filtersOffered: false,
  };
}
