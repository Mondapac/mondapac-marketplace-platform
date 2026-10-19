import 'server-only';
import { SAMPLE_CERTIFICATION_NAMES, SAMPLE_PRODUCTS, sampleSellerId } from './sample-catalog.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import type {
  Money,
  ProductCard,
  ProductDetail,
  ProductOffer,
  ProductSpecification,
  SellerProfile,
} from './types.ts';

// Sample data of the product page (approved design v8). It stands in for the product detail
// read (offers by product, stock, gallery, specifications, description), the seller card data
// and similar products until the backend has them; only this file goes when the read is wired.
// Ratings, delivery promises, minimum orders and other sellers are sample values.

const money = (amount: number): Money => ({ amount, currency: 'AUD' });

type Profile = Omit<SellerProfile, 'id' | 'name' | 'logo' | 'certificates'>;

const PROFILES: Readonly<Record<string, Profile>> = {
  kedron: {
    city: 'Brisbane',
    sellingSince: 2025,
    ratings: { satisfaction: 96, count: 214, onTime: 98, asDescribed: 99 },
  },
  'mt-gravatt': {
    city: 'Mt Gravatt',
    sellingSince: 2025,
    ratings: { satisfaction: 94, count: 158, onTime: 97, asDescribed: 98 },
  },
};

const FALLBACK: Profile = {
  city: 'Brisbane',
  sellingSince: 2025,
  ratings: { satisfaction: 93, count: 87, onTime: 96, asDescribed: 98 },
};

/** A seller that is not on the home page and has no profile logo (the default tile shows). */
const LOGAN_ROAD: SellerProfile = {
  id: 'logan-road',
  name: 'Logan Road Meats',
  city: 'Brisbane',
  sellingSince: 2026,
  certificates: [],
  ratings: { satisfaction: 91, count: 42, onTime: 95, asDescribed: 97 },
};

function profileOf(id: string, certified: readonly string[]): SellerProfile {
  const seller = SAMPLE_CONTENT.sellers.find((s) => s.id === id)!;
  return {
    id,
    name: seller.name,
    ...(seller.logo === undefined ? {} : { logo: seller.logo }),
    ...(PROFILES[id] ?? FALLBACK),
    certificates: certified.map((type) => ({ type, name: SAMPLE_CERTIFICATION_NAMES[type]! })),
  };
}

/** The offer a product card shows: its seller's, with the seller's delivery promise. */
function featuredOffer(product: ProductCard): ProductOffer {
  const sellerId = sampleSellerId(product)!;
  const summary = SAMPLE_CONTENT.sellers.find((s) => s.id === sellerId)!;
  return {
    // The card and the page share the cart line: the featured offer's id is the product id.
    id: product.id,
    seller: profileOf(
      sellerId,
      product.certifications.map((c) => c.type),
    ),
    price: product.price,
    ...(product.wasPrice ? { wasPrice: product.wasPrice } : {}),
    certifications: product.certifications,
    ...(product.lowStock === undefined ? {} : { lowStock: product.lowStock }),
    deliveryWindow: summary.deliveryWindow,
    minimumOrder: summary.minimumOrder,
  };
}

interface Extra {
  readonly description: string;
  readonly specifications: readonly ProductSpecification[];
  readonly photos?: readonly string[];
  readonly others?: (product: ProductCard) => ProductOffer[];
  readonly similar?: readonly string[];
}

const EXTRA: Readonly<Record<string, Extra>> = {
  'whole-chicken': {
    description:
      'Whole free-range chicken from a Queensland farm, prepared by Kedron Halal Butchers and vacuum sealed for freshness. Ideal for roasting, grilling or portioning at home. The birds are raised outdoors on a family farm west of Brisbane and processed the same week they are sold. Kedron Halal Butchers prepares each one by hand, so the weight can vary slightly from the size shown. Keep it refrigerated and use it by the date shown on the pack, or freeze it for up to three months. For the best result, take it out of the fridge 30 minutes before cooking and pat the skin dry.',
    specifications: [
      { label: 'Weight', value: 'About 1.6 kg' },
      { label: 'Type', value: 'Free-range, whole' },
      { label: 'Storage', value: 'Keep refrigerated at 0 to 4 °C' },
      { label: 'Packaging', value: 'Vacuum sealed' },
      { label: 'Origin', value: 'Queensland, Australia' },
      { label: 'Use by', value: 'Shown on the pack' },
    ],
    photos: ['chicken', 'meat', 'egg', 'cheese'],
    others: (product) => [
      {
        id: `${product.id}:mt-gravatt`,
        seller: profileOf('mt-gravatt', []),
        price: money(2190),
        certifications: [],
        deliveryWindow: 'Tomorrow 12pm-4pm',
        minimumOrder: 'A$30 minimum order',
      },
      {
        id: `${product.id}:logan-road`,
        seller: LOGAN_ROAD,
        price: money(2450),
        certifications: [],
        deliveryWindow: 'Tomorrow 12pm-4pm',
        minimumOrder: 'No minimum order',
      },
    ],
    similar: ['lamb-shoulder', 'brisket', 'basmati', 'bananas', 'apples', 'oranges'],
  },
};

const SIMILAR_COUNT = 6;

/** Six other products, the same category first. */
function similarTo(product: ProductCard): ProductCard[] {
  const others = SAMPLE_PRODUCTS.filter((p) => p.id !== product.id);
  return [
    ...others.filter((p) => p.category === product.category),
    ...others.filter((p) => p.category !== product.category),
  ].slice(0, SIMILAR_COUNT);
}

export function sampleProduct(id: string): ProductDetail | undefined {
  const product = SAMPLE_PRODUCTS.find((p) => p.id === id);
  if (!product) return undefined;
  const extra = EXTRA[id];
  const photos =
    extra?.photos?.map((key) => `/placeholders/${key}.jpg`) ??
    (product.imageUrl ? [product.imageUrl] : []);
  const similar = extra?.similar
    ? extra.similar.map((key) => SAMPLE_PRODUCTS.find((p) => p.id === key)!)
    : similarTo(product);
  return {
    id,
    name: product.name,
    category: product.category,
    description:
      extra?.description ??
      `${product.name} from ${product.sellerName}, a local seller in Brisbane. Delivered by the seller in the window shown.`,
    specifications: extra?.specifications ?? [],
    photos,
    offers: [featuredOffer(product), ...(extra?.others?.(product) ?? [])],
    similar,
  };
}
