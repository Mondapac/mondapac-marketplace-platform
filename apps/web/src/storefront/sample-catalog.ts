import 'server-only';
import { PRODUCTS, SAMPLE_CONTENT } from './sample-home.ts';
import type { ListingBanner, Money, PriceBand, ProductCard } from './types.ts';

// Sample data of the listing pages. It stands in for the search route's per-product category
// ids, sellers and delivery options, and for the listing banner slot (admin-managed content of
// PR #401), until the API has them; only this file goes when the routes are wired.

const money = (amount: number): Money => ({ amount, currency: 'AUD' });

type Row = [
  id: string,
  name: string,
  seller: string,
  category: string,
  price: number,
  extra?: { was?: number; low?: number; img?: string },
];

// More pantry and meat products than the home page shows, so a listing has more than one page.
const MORE: Row[] = [
  ['chickpeas', 'Chickpeas, 400 g can', 'Sunnybank Pantry Co', 'pantry', 220],
  ['lentils', 'Red lentils, 1 kg', 'Sunnybank Pantry Co', 'pantry', 590, { was: 690 }],
  ['tahini', 'Hulled tahini, 450 g', 'Inala Spice House', 'pantry', 890],
  ['couscous', 'Couscous, 1 kg', 'Sunnybank Pantry Co', 'pantry', 490],
  ['pistachios', 'Roasted pistachios, 250 g', 'Inala Spice House', 'pantry', 1290, { low: 2 }],
  ['vermicelli', 'Rice vermicelli, 400 g', 'Sunnybank Pantry Co', 'pantry', 320],
  ['rose-water', 'Rose water, 250 ml', 'Inala Spice House', 'pantry', 650, { was: 750 }],
  ['jasmine-rice', 'Jasmine rice, 5 kg', 'Sunnybank Pantry Co', 'pantry', 1790],
  ['date-syrup', 'Date syrup, 400 g', 'Inala Spice House', 'pantry', 990],
  ['lamb-mince', 'Lamb mince, 500 g', 'Kedron Halal Butchers', 'meat', 1190, { img: 'meat' }],
  ['beef-sausages', 'Beef sausages, 8 pack', 'Kedron Halal Butchers', 'meat', 1050, { low: 6 }],
  ['lamb-cutlets', 'Lamb cutlets, 500 g', 'Kedron Halal Butchers', 'meat', 2690, { was: 2990 }],
];

const MORE_PRODUCTS: ProductCard[] = MORE.map(
  ([id, name, sellerName, category, price, extra = {}]) => {
    // Every sample meat product comes from a certified butcher, as on the home page.
    const certifications =
      category === 'meat' ? PRODUCTS.find((p) => p.category === 'meat')!.certifications : [];
    return {
      id,
      name,
      sellerName,
      category,
      price: money(price),
      ...(extra.was === undefined ? {} : { wasPrice: money(extra.was) }),
      certifications,
      ...(extra.low === undefined ? {} : { lowStock: extra.low }),
      ...(extra.img === undefined ? {} : { imageUrl: `/placeholders/${extra.img}.jpg` }),
    };
  },
);

/** Every sample product a listing can show, home page products first. */
export const SAMPLE_PRODUCTS: readonly ProductCard[] = [...PRODUCTS, ...MORE_PRODUCTS];

// Subcategory of each sample product (codes from the sample category tree in ./sample-home.ts).
// It stands in for the category ids the search route returns per product.
export const SAMPLE_SUBCATEGORY: Readonly<Record<string, string>> = {
  'lamb-shoulder': 'lamb',
  brisket: 'beef',
  'whole-chicken': 'whole-chicken',
  sourdough: 'bread',
  flatbread: 'wraps-and-flatbread',
  croissants: 'pastries',
  basmati: 'rice-and-grains',
  medjool: 'nuts-and-dried-fruit',
  honey: 'honey-and-spreads',
  'olive-oil': 'oils-and-vinegars',
  'coconut-milk': 'canned-goods',
  saffron: 'saffron',
  hummus: 'dips-and-hummus',
  eggs: 'eggs',
  cheese: 'cheese',
  bananas: 'fruit',
  apples: 'fruit',
  oranges: 'fruit',
  watermelon: 'fruit',
  'fruit-box': 'fruit',
  chickpeas: 'canned-goods',
  lentils: 'rice-and-grains',
  tahini: 'honey-and-spreads',
  couscous: 'rice-and-grains',
  pistachios: 'nuts-and-dried-fruit',
  vermicelli: 'pasta-and-noodles',
  'rose-water': 'oils-and-vinegars',
  'jasmine-rice': 'rice-and-grains',
  'date-syrup': 'honey-and-spreads',
  'lamb-mince': 'mince',
  'beef-sausages': 'sausages-and-burgers',
  'lamb-cutlets': 'lamb',
};

/** The seller id of a sample product (the API returns seller ids; the sample has names). */
export function sampleSellerId(product: ProductCard): string | undefined {
  return SAMPLE_CONTENT.sellers.find((s) => s.name === product.sellerName)?.id;
}

/** Sellers that deliver the same day in the sample delivery area. */
export const SAMPLE_SAME_DAY_SELLERS: ReadonlySet<string> = new Set(['paddington', 'moorooka']);

/** Display name of each certification type (the quick filter chip); the API gives it per type. */
export const SAMPLE_CERTIFICATION_NAMES: Readonly<Record<string, string>> = {
  halal: 'Halal',
};

/** The price bands of the Price filter (shape in ./types.ts). */
export const SAMPLE_PRICE_BANDS: readonly PriceBand[] = [
  { id: 'under-10', below: money(1000) },
  { id: '10-to-20', from: money(1000), to: money(2000) },
  { id: 'over-20', above: money(2000) },
];

/** The promotion banner of a listing, by category code; most listings have none. */
export const SAMPLE_LISTING_BANNERS: Readonly<Record<string, ListingBanner>> = {
  meat: {
    title: 'Halal specials this week',
    body: 'Lamb, beef and chicken from Kedron Halal Butchers on special.',
    action: { label: 'Shop now', href: '/c/meat?special=1' },
    imageUrl: '/placeholders/meat.jpg',
  },
  pantry: {
    title: 'Pantry staples for less',
    body: 'Rice, lentils and honey from Sunnybank Pantry Co, this week only.',
    action: { label: 'Shop now', href: '/c/pantry?special=1' },
    imageUrl: '/placeholders/coconut.jpg',
  },
};
