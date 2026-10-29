import 'server-only';
import type { SellerFilters, SellerSort } from '../sellers/sellers-state.ts';
import { DISTANCES, withoutDistance } from '../sellers/sellers-state.ts';
import { SAMPLE_SAME_DAY_SELLERS } from './sample-catalog.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import { SAMPLE_SELLER_SLUGS, sampleSeller } from './sample-seller.ts';
import type {
  BuyerLocation,
  MinimumBucket,
  SellerListing,
  SellerQuery,
  SellerResults,
} from './types.ts';

// Sample data of the sellers page (approved design sellers-a-teal v4). It stands in for a seller
// list read (filters, sort, counts and the buyer's distance to each store) until the backend has
// one; only this file goes when the read is wired. Every value here is a sample.

const money = (amount: number) => ({ amount, currency: 'AUD' });

/** The sample buyer is at Brisbane 4000 (the header's sample area), inside the delivery area. */
const SAMPLE_LOCATION: BuyerLocation = 'inside';

/** The list-only facts of each sample store: distance from Brisbane 4000 and delivery there. */
const LIST: Readonly<
  Record<
    string,
    {
      readonly km: number;
      readonly deliversHere?: false;
      readonly sameDay?: true;
      /** For a store without sample products: its categories and product count. */
      readonly categories?: readonly string[];
      readonly productCount?: number;
    }
  >
> = {
  kedron: { km: 2.4 },
  paddington: { km: 3.1 },
  sunnybank: { km: 8.9 },
  inala: { km: 11.2 },
  moorooka: { km: 7.6 },
  'mt-gravatt': { km: 6.8 },
  'logan-road': { km: 5.2, categories: ['meat'], productCount: 22 },
  coorparoo: { km: 4.5, categories: ['pantry'], productCount: 12 },
  'sunnybank-halal-meats': {
    km: 9.3,
    sameDay: true,
    categories: ['meat', 'poultry'],
    productCount: 38,
  },
  indooroopilly: { km: 7.9, categories: ['bakery', 'pantry'], productCount: 17 },
  redcliffe: { km: 28, categories: ['meals'], productCount: 14 },
  toowoomba: { km: 130, deliversHere: false, categories: ['produce', 'dairy'], productCount: 29 },
  annerley: { km: 4.1, sameDay: true, categories: ['pantry', 'meat'], productCount: 46 },
  wynnum: { km: 14.8, categories: ['poultry'], productCount: 15 },
  carindale: { km: 9.9, sameDay: true, categories: ['bakery'], productCount: 24 },
  chermside: { km: 10.6, categories: ['spices'], productCount: 33 },
  sherwood: { km: 8.1, categories: ['produce'], productCount: 18 },
  'ipswich-road-dairy': { km: 7.3, categories: ['dairy', 'pantry'], productCount: 21 },
};

/** The buckets of the Minimum order filter (labels are built from the amounts). */
export const SAMPLE_MINIMUM_BUCKETS: readonly MinimumBucket[] = [
  { id: 'none' },
  { id: 'up-to-30', max: money(3000) },
  { id: 'up-to-40', max: money(4000) },
];

const categoryName = (code: string) =>
  SAMPLE_CONTENT.categories.find((c) => c.code === code)?.name ?? code;

function listing(slug: string, location: BuyerLocation): SellerListing {
  const shop = sampleSeller(slug)!;
  const list = LIST[slug]!;
  const categories =
    shop.categories.length > 0
      ? shop.categories
      : (list.categories ?? []).map((code) => ({ code, name: categoryName(code) }));
  const thumbnails =
    shop.products.length > 0
      ? shop.products.slice(0, 3).map((p) => ({
          category: p.category,
          ...(p.imageUrl === undefined ? {} : { imageUrl: p.imageUrl }),
        }))
      : categories.slice(0, 3).map((c) => ({ category: c.code }));
  return {
    id: shop.id,
    name: shop.name,
    ...(shop.logo === undefined ? {} : { logo: shop.logo }),
    city: shop.location.split(',')[0]!,
    sellingSince: shop.sellingSince,
    ...(shop.ratings
      ? { ratings: { satisfaction: shop.ratings.satisfaction, count: shop.ratings.count } }
      : {}),
    certifications: shop.certificates.map((c) => ({ type: c.type, name: c.name })),
    categories,
    sameDay: list.sameDay ?? SAMPLE_SAME_DAY_SELLERS.has(slug),
    ...(shop.minimumOrder ? { minimumOrder: shop.minimumOrder } : {}),
    productCount: list.productCount ?? shop.products.length,
    thumbnails,
    deliversHere: location !== 'inside' || list.deliversHere !== false,
    ...(location === 'inside' ? { distanceKm: list.km } : {}),
  };
}

const isNew = (s: SellerListing) => s.ratings === undefined;

function fits(s: SellerListing, bucket: MinimumBucket): boolean {
  if (bucket.max === undefined) return s.minimumOrder === undefined;
  const { minimumOrder: min } = s;
  return (
    min === undefined || (min.currency === bucket.max.currency && min.amount <= bucket.max.amount)
  );
}

function matches(s: SellerListing, filters: SellerFilters): boolean {
  if (filters.newSellers && !isNew(s)) return false;
  if (filters.sameDay && !s.sameDay) return false;
  if (!filters.certifications.every((type) => s.certifications.some((c) => c.type === type)))
    return false;
  if (
    filters.categories.length > 0 &&
    !s.categories.some((c) => filters.categories.includes(c.code))
  )
    return false;
  const buckets = SAMPLE_MINIMUM_BUCKETS.filter((b) => filters.minimums.includes(b.id));
  if (filters.minimums.length > 0 && !buckets.some((b) => fits(s, b))) return false;
  if (filters.distance !== undefined && (s.distanceKm ?? Infinity) > filters.distance) return false;
  return true;
}

/** Ratings count stands in for orders in Most popular, until a popularity measure exists. */
const orders = (s: SellerListing) => s.ratings?.count ?? 0;

const ORDER: Readonly<Record<SellerSort, (a: SellerListing, b: SellerListing) => number>> = {
  popular: (a, b) => orders(b) - orders(a) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  newest: (a, b) => b.sellingSince - a.sellingSince || a.name.localeCompare(b.name),
  nearest: (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
};

/**
 * The stores for a query. Distance and Nearest first need the location inside the area; outside
 * it the read ignores them (Most popular instead), as the real read is to.
 */
export function sampleSellers(query: SellerQuery, location = SAMPLE_LOCATION): SellerResults {
  const all = SAMPLE_SELLER_SLUGS.map((slug) => listing(slug, location));
  const inside = location === 'inside';
  const filters = inside ? query.filters : withoutDistance(query.filters);
  const sort = query.sort === 'nearest' && !inside ? 'popular' : query.sort;
  const found = all.filter((s) => matches(s, filters)).sort(ORDER[sort]);
  const count = (test: (s: SellerListing) => boolean) => all.filter(test).length;
  const types = [...new Set(all.flatMap((s) => s.certifications.map((c) => c.type)))];
  const codes = SAMPLE_CONTENT.categories
    .map((c) => c.code)
    .filter((code) => all.some((s) => s.categories.some((c) => c.code === code)));
  return {
    items: found.slice(0, query.limit),
    total: found.length,
    all: all.length,
    location,
    facets: {
      newSellers: count(isNew),
      sameDay: count((s) => s.sameDay),
      certifications: types.map((type) => ({
        id: type,
        name: all.flatMap((s) => s.certifications).find((c) => c.type === type)!.name,
        count: count((s) => s.certifications.some((c) => c.type === type)),
      })),
      categories: codes.map((code) => ({
        id: code,
        name: categoryName(code),
        count: count((s) => s.categories.some((c) => c.code === code)),
      })),
      minimums: SAMPLE_MINIMUM_BUCKETS.map((bucket) => ({
        id: bucket.id,
        bucket,
        count: count((s) => fits(s, bucket)),
      })),
      distances:
        location === 'inside'
          ? DISTANCES.map((km) => ({ km, count: count((s) => (s.distanceKm ?? Infinity) <= km) }))
          : [],
    },
  };
}
