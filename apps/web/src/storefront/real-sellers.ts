import { CLOCK_TIME } from '../format/clock.ts';
import type { DeliveryTerms, Money, SellerListing, SellerResults, SellerShop } from './types.ts';

// The API's public store answers (`GET sellers/stores`, `GET sellers/stores/:slug`) as the
// storefront's seller types. The body is untrusted: anything that is not the expected shape is
// refused whole, never shown in part. The API answers only what it holds today (name, area, year,
// minimum order); every other field stays absent, and the pages leave its part out rather than
// show a value nobody gave (no "no certificates", no "0 products").

/** A store as the API answers it. */
export interface PublicStore {
  readonly slug: string;
  readonly name: string;
  readonly serviceAreaCode: string;
  readonly sellingSince: number;
  /** null: no minimum. Absent: not known now, so no minimum line is shown. */
  readonly minimumOrder?: Money | null;
  /** The seller's delivery terms. Absent: the seller set none, so no delivery line is shown. */
  readonly delivery?: DeliveryTerms;
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

const minutesOf = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** The delivery terms of a store, or undefined when the API sent none. Anything else is refused. */
function deliveryOf(value: unknown): DeliveryTerms | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new StoreAnswerRefused('delivery');
  const { day, from, to, cutoff } = value;
  if (day !== 'same-day' && day !== 'next-day') throw new StoreAnswerRefused('delivery.day');
  for (const [name, time] of [
    ['from', from],
    ['to', to],
    ['cutoff', cutoff],
  ] as const) {
    if (typeof time !== 'string' || !CLOCK_TIME.test(time)) {
      throw new StoreAnswerRefused(`delivery.${name}`);
    }
  }
  const [open, close, last] = [from, to, cutoff] as [string, string, string];
  if (minutesOf(open) >= minutesOf(close) || open === '24:00' || last === '24:00') {
    throw new StoreAnswerRefused('delivery.window');
  }
  return { day, from: open, to: close, cutoff: last };
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
  const delivery = deliveryOf(value['delivery']);
  const store = {
    slug,
    name,
    serviceAreaCode,
    sellingSince,
    ...(delivery === undefined ? {} : { delivery }),
  };
  return minimumOrder === undefined ? store : { ...store, minimumOrder };
}

/** A store's flat delivery fee as the API answers it (`GET shipping/stores/:slug/flat-fee`). */
export function flatFeeOf(value: unknown): Money {
  if (!isRecord(value)) throw new StoreAnswerRefused('flat fee');
  const { amount, currency } = value;
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
    throw new StoreAnswerRefused('flat fee.amount');
  }
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    throw new StoreAnswerRefused('flat fee.currency');
  }
  return { amount: Number(amount), currency };
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
    ...(store.delivery === undefined ? {} : { delivery: store.delivery }),
  };
  if (store.minimumOrder === undefined) return { ...shop, minimumUnknown: true };
  return store.minimumOrder === null ? shop : { ...shop, minimumOrder: store.minimumOrder };
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
  if (store.minimumOrder === undefined) return { ...listing, minimumUnknown: true };
  return store.minimumOrder === null ? listing : { ...listing, minimumOrder: store.minimumOrder };
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
