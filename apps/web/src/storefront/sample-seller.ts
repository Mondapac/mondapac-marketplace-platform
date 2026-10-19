import 'server-only';
import { SAMPLE_TERMS } from './sample-cart.ts';
import { SAMPLE_CERTIFICATION_NAMES, SAMPLE_PRODUCTS, sampleSellerId } from './sample-catalog.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import type { Money, SellerCertificate, SellerShop } from './types.ts';

// Sample data of the seller page (approved design, seller-a-teal v9). It stands in for the seller
// public read (profile, terms, certificates, ratings and the product list) until the backend has
// it; only this file goes when the read is wired. Every value here is a sample.

const money = (amount: number): Money => ({ amount, currency: 'AUD' });

interface Profile {
  readonly location: string;
  readonly sellingSince: number;
  readonly about: string;
  readonly ratings?: SellerShop['ratings'];
  readonly certificates?: readonly Omit<SellerCertificate, 'name'>[];
}

const PROFILES: Readonly<Record<string, Profile>> = {
  kedron: {
    location: 'Kedron, Brisbane',
    sellingSince: 2025,
    about:
      'Family-run halal butchery in Kedron. We prepare every cut ourselves and deliver across Greater Brisbane. Lamb, beef, goat and free-range chicken, cut to order and packed the same morning.',
    ratings: { satisfaction: 96, onTime: 98, asDescribed: 99, count: 214 },
    certificates: [
      {
        type: 'halal',
        certifier: 'Sample Halal Certifier',
        number: 'HC-2025-0142',
        validUntil: '2027-06-30',
        checkedOn: '2026-09-12',
      },
    ],
  },
  paddington: {
    location: 'Paddington, Brisbane',
    sellingSince: 2025,
    about:
      'Small neighbourhood bakehouse in Paddington. Sourdough, Lebanese and Turkish breads and pastries, baked every morning and delivered the same day.',
    ratings: { satisfaction: 95, onTime: 97, asDescribed: 99, count: 98 },
  },
  sunnybank: {
    location: 'Sunnybank, Brisbane',
    sellingSince: 2025,
    about:
      'Pantry staples from Sunnybank: rice, lentils, oils, canned goods and noodles, packed to order and delivered across Greater Brisbane.',
    ratings: { satisfaction: 93, onTime: 96, asDescribed: 98, count: 87 },
  },
  inala: {
    location: 'Inala, Brisbane',
    sellingSince: 2025,
    about:
      'Spices, nuts, dried fruit and syrups from Inala, ground and packed in small batches each week.',
    ratings: { satisfaction: 93, onTime: 96, asDescribed: 98, count: 87 },
  },
  moorooka: {
    location: 'Moorooka, Brisbane',
    sellingSince: 2025,
    about: 'Eggs, cheese, yoghurt and dips from Moorooka, delivered chilled the same day.',
    ratings: { satisfaction: 93, onTime: 96, asDescribed: 98, count: 87 },
  },
  'mt-gravatt': {
    location: 'Mt Gravatt, Brisbane',
    sellingSince: 2025,
    about:
      'Fruit, vegetables and fresh fish from the Mt Gravatt markets, picked each morning for delivery the next day.',
    ratings: { satisfaction: 94, onTime: 97, asDescribed: 98, count: 158 },
  },
};

/** Sellers that are not on the home page; neither has a profile logo (the default tile shows). */
const OTHERS: Readonly<
  Record<string, Profile & { readonly name: string; readonly deliveryWindow: string }>
> = {
  'logan-road': {
    name: 'Logan Road Meats',
    deliveryWindow: 'Tomorrow 12pm-4pm',
    location: 'Upper Mount Gravatt, Brisbane',
    sellingSince: 2026,
    about: 'Butcher on Logan Road. Beef, lamb and chicken, cut to order.',
    ratings: { satisfaction: 91, onTime: 95, asDescribed: 97, count: 42 },
  },
  coorparoo: {
    name: 'Coorparoo Pantry',
    deliveryWindow: 'Tomorrow 12pm-4pm',
    location: 'Coorparoo, Brisbane',
    sellingSince: 2026,
    about: 'New to Mondapac. Pantry staples and spices from local suppliers.',
  },
};

// The first listing day of the sample products; later products in the catalogue are newer.
const FIRST_LISTED = Date.UTC(2026, 6, 1);
const DAY = 86_400_000;

export function sampleSeller(slug: string): SellerShop | undefined {
  const summary = SAMPLE_CONTENT.sellers.find((s) => s.id === slug);
  const other = OTHERS[slug];
  const profile = PROFILES[slug] ?? other;
  if (!profile) return undefined;
  const name = summary?.name ?? other!.name;
  const { minimum, fee } = SAMPLE_TERMS[slug] ?? { fee: 500 };
  const products = SAMPLE_PRODUCTS.flatMap((p, index) =>
    sampleSellerId(p) === slug
      ? [{ ...p, listedAt: new Date(FIRST_LISTED + index * DAY).toISOString().slice(0, 10) }]
      : [],
  );
  const codes = new Set(products.map((p) => p.category));
  return {
    id: slug,
    name,
    ...(summary?.logo === undefined ? {} : { logo: summary.logo }),
    location: profile.location,
    sellingSince: profile.sellingSince,
    about: profile.about,
    businessCheck: 'ABN checked by Mondapac',
    deliveryWindow: summary?.deliveryWindow ?? other!.deliveryWindow,
    deliveryFee: money(fee),
    ...(minimum === undefined ? {} : { minimumOrder: money(minimum) }),
    deliversTo: 'Greater Brisbane',
    certificates: (profile.certificates ?? []).map((c) => ({
      ...c,
      name: SAMPLE_CERTIFICATION_NAMES[c.type]!,
    })),
    ...(profile.ratings ? { ratings: profile.ratings } : {}),
    categories: SAMPLE_CONTENT.categories
      .filter((c) => codes.has(c.code))
      .map((c) => ({ code: c.code, name: c.name })),
    products,
  };
}
