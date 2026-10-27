import 'server-only';
import { SAMPLE_PRODUCTS, sampleSellerId } from './sample-catalog.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import { sampleProduct } from './sample-product.ts';
import type {
  CartItem,
  CartSource,
  CheckoutPlace,
  CheckoutSource,
  Money,
  SellerTerms,
} from './types.ts';

// Sample data of the cart and checkout (approved design, cart-a-teal v3). It stands in for the
// cart read's line details, each seller's minimum order, delivery fee and window, the
// price-changed flag, the tax figure, the customer's address book and the service-area check
// until the backend has them (handoffs/cart-checkout.md, PR 2); only this file goes when the
// screens are wired. Every value here is a sample.

const money = (amount: number): Money => ({ amount, currency: 'AUD' });

/** Minimum order per seller (sample values of the prototype). A seller sets no delivery terms. */
export const SAMPLE_TERMS: Readonly<Record<string, { minimum?: number }>> = {
  kedron: { minimum: 4000 },
  paddington: {},
  sunnybank: { minimum: 3000 },
  inala: {},
  moorooka: { minimum: 2500 },
  'mt-gravatt': { minimum: 3000 },
  'logan-road': {},
};

/** The price a line had when it was added, for the lines whose price changed since (sample). */
const ADDED_AT: Readonly<Record<string, number>> = { brisket: 4890 };

function terms(id: string, name: string, logo?: string): SellerTerms {
  const { minimum } = SAMPLE_TERMS[id] ?? {};
  return {
    id,
    name,
    ...(logo === undefined ? {} : { logo }),
    ...(minimum === undefined ? {} : { minimumOrder: money(minimum) }),
  };
}

function build(): CartSource {
  const sellers: Record<string, SellerTerms> = {};
  for (const s of SAMPLE_CONTENT.sellers) sellers[s.id] = terms(s.id, s.name, s.logo);
  const items: Record<string, CartItem> = {};
  for (const product of SAMPLE_PRODUCTS) {
    const sellerId = sampleSellerId(product);
    if (sellerId === undefined) continue;
    const addedAt = ADDED_AT[product.id];
    items[product.id] = {
      name: product.name,
      sellerId,
      category: product.category,
      price: product.price,
      ...(product.lowStock === undefined ? {} : { lowStock: product.lowStock }),
      ...(product.imageUrl === undefined ? {} : { imageUrl: product.imageUrl }),
      ...(addedAt === undefined ? {} : { addedAt: money(addedAt) }),
    };
    // Other sellers' offers of the product page (only the rich sample product has them).
    for (const offer of sampleProduct(product.id)?.offers.slice(1) ?? []) {
      sellers[offer.seller.id] ??= terms(offer.seller.id, offer.seller.name, offer.seller.logo);
      items[offer.id] = {
        name: product.name,
        sellerId: offer.seller.id,
        category: product.category,
        price: offer.price,
        ...(offer.lowStock === undefined ? {} : { lowStock: offer.lowStock }),
        ...(product.imageUrl === undefined ? {} : { imageUrl: product.imageUrl }),
      };
    }
  }
  return {
    items,
    sellers,
    // PLACEHOLDER (not a rule): the prototype's "Includes A$x GST" on the items. The tax module
    // gives this figure when the cart is wired; a delivery's GST comes from its quote.
    tax: { share: { numerator: 1, denominator: 11 } },
    sampleDiscounts: { HALAL10: { code: 'HALAL10', percentOff: 10 } },
  };
}

export const SAMPLE_CART_SOURCE: CartSource = build();

/** The suburbs of the stubbed address search and three made-up street addresses in each. */
function samplePlaces(): CheckoutPlace[] {
  const suburbs: readonly (readonly [string, string])[] = [
    ['Kedron', '4031'],
    ['Brisbane City', '4000'],
    ['Chermside', '4032'],
    ['Paddington', '4064'],
    ['Mount Gravatt', '4122'],
    ['West End', '4101'],
    ['Indooroopilly', '4068'],
    ['Toowong', '4066'],
    ['Carindale', '4152'],
    ['Sunnybank', '4109'],
    ['New Farm', '4005'],
    ['Nundah', '4012'],
  ];
  const streets = [
    'Example Street',
    'Sample Road',
    'Test Avenue',
    'Demo Lane',
    'Sandgate Road',
    'Brunswick Street',
    'Hill Terrace',
  ];
  const numbers = [12, 48, 7, 31];
  const places: CheckoutPlace[] = [];
  suburbs.forEach(([suburb, postcode], i) => {
    const key = suburb.toLowerCase().replace(/\s+/g, '-');
    places.push({ id: key, street: '', suburb, regionCode: 'QLD', postcode });
    for (const j of [0, 1, 2]) {
      const street = `${numbers[(i + j) % numbers.length]} ${streets[(i + j * 2) % streets.length]}`;
      places.push({ id: `${key}-${j}`, street, suburb, regionCode: 'QLD', postcode });
    }
  });
  return places;
}

export const SAMPLE_CHECKOUT: CheckoutSource = {
  areaCheck: 'sample',
  card: { kind: 'sample' },
  customer: {
    firstName: 'Alex',
    fullName: 'Alex Nguyen',
    email: 'alex.nguyen@example.com',
    addresses: [
      {
        id: 'home',
        firstName: 'Alex',
        lastName: 'Nguyen',
        street: '12 Example Street',
        line2: null,
        suburb: 'Kedron',
        postcode: '4031',
        phone: '0400 000 000',
        deliveryNotes: null,
        isDefault: true,
      },
      {
        id: 'work',
        firstName: 'Sam',
        lastName: 'Nguyen',
        street: 'Level 3, 100 Sample Road',
        line2: null,
        suburb: 'Brisbane City',
        postcode: '4000',
        phone: '0400 000 000',
        deliveryNotes: null,
        isDefault: false,
      },
    ],
  },
  // Launch area (ServiceArea config): Greater Brisbane.
  serviceArea: {
    name: 'Greater Brisbane',
    region: 'Queensland',
    regionCode: 'QLD',
    postcodes: [{ from: '4000', to: '4199' }],
    postcodeInput: 'numeric',
  },
  orderReference: 'MP-20481',
  places: samplePlaces(),
};
