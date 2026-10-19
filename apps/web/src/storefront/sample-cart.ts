import 'server-only';
import { SAMPLE_PRODUCTS, sampleSellerId } from './sample-catalog.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import { sampleProduct } from './sample-product.ts';
import type { CartItem, CartSource, CheckoutSource, Money, SellerTerms } from './types.ts';

// Sample data of the cart and checkout (approved design, cart-a-teal v3). It stands in for the
// cart read's line details, each seller's minimum order, delivery fee and window, the
// price-changed flag, the tax figure, the customer's address book and the service-area check
// until the backend has them (handoffs/cart-checkout.md, PR 2); only this file goes when the
// screens are wired. Every value here is a sample.

const money = (amount: number): Money => ({ amount, currency: 'AUD' });

/** Minimum order and delivery fee per seller (sample values of the prototype). */
export const SAMPLE_TERMS: Readonly<Record<string, { minimum?: number; fee: number }>> = {
  kedron: { minimum: 4000, fee: 750 },
  paddington: { fee: 500 },
  sunnybank: { minimum: 3000, fee: 600 },
  inala: { fee: 500 },
  moorooka: { minimum: 2500, fee: 550 },
  'mt-gravatt': { minimum: 3000, fee: 600 },
  'logan-road': { fee: 650 },
};

/** The price a line had when it was added, for the lines whose price changed since (sample). */
const ADDED_AT: Readonly<Record<string, number>> = { brisket: 4890 };

function terms(id: string, name: string, deliveryWindow: string, logo?: string): SellerTerms {
  const { minimum, fee } = SAMPLE_TERMS[id] ?? { fee: 500 };
  return {
    id,
    name,
    ...(logo === undefined ? {} : { logo }),
    deliveryWindow,
    ...(minimum === undefined ? {} : { minimumOrder: money(minimum) }),
    deliveryFee: money(fee),
  };
}

function build(): CartSource {
  const sellers: Record<string, SellerTerms> = {};
  for (const s of SAMPLE_CONTENT.sellers)
    sellers[s.id] = terms(s.id, s.name, s.deliveryWindow, s.logo);
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
      sellers[offer.seller.id] ??= terms(
        offer.seller.id,
        offer.seller.name,
        offer.deliveryWindow,
        offer.seller.logo,
      );
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
    // PLACEHOLDER (not a rule): the prototype's "Includes A$x GST" on the whole total. The tax
    // module gives this figure when the cart is wired; tax on delivery fees is not settled.
    tax: { share: { numerator: 1, denominator: 11 }, includesDelivery: true },
    sampleDiscounts: { HALAL10: { code: 'HALAL10', percentOff: 10 } },
  };
}

export const SAMPLE_CART_SOURCE: CartSource = build();

export const SAMPLE_CHECKOUT: CheckoutSource = {
  customer: {
    firstName: 'Alex',
    fullName: 'Alex Nguyen',
    email: 'alex.nguyen@example.com',
    addresses: [
      {
        id: 'home',
        label: 'Home',
        name: 'Alex Nguyen',
        line: '12 Example Street, Kedron QLD 4031',
        phone: '0400 000 000',
        isDefault: true,
      },
      {
        id: 'work',
        label: 'Work',
        name: 'Alex Nguyen',
        line: 'Level 3, 100 Sample Road, Brisbane City QLD 4000',
        phone: '0400 000 000',
        isDefault: false,
      },
    ],
  },
  // Launch area (ServiceArea config): Greater Brisbane.
  serviceArea: {
    name: 'Greater Brisbane',
    region: 'Queensland',
    postcodes: [{ from: '4000', to: '4199' }],
  },
  orderReference: 'MP-20481',
};
